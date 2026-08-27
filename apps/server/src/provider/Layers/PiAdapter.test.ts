// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  PI_DRIVER_KIND,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { encodePiModelSlug } from "../pi/PiModelCatalog.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPath = NodePath.join(__dirname, "../../../scripts/pi-adapter-mock-agent.mjs");
const instanceId = ProviderInstanceId.make("pi_test");

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-test-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
const nodeIt = it.layer(testLayer);

function makeTestAdapter(input?: {
  readonly startupDialog?: boolean | "select" | "confirm" | "input" | "editor";
  readonly dialogTimeout?: number;
  readonly dialogCrash?: boolean;
  readonly permissionTool?: string;
  readonly forkCancel?: boolean;
  readonly forkDialog?: boolean;
  readonly entries?: ReadonlyArray<unknown>;
  readonly uiEvents?: boolean;
  readonly logPath?: string;
  readonly nativeRecords?: unknown[];
}) {
  return makePiAdapter({
    environment: {
      ...(input?.startupDialog
        ? {
            PI_ADAPTER_MOCK_STARTUP_DIALOG:
              input.startupDialog === true ? "1" : input.startupDialog,
          }
        : {}),
      ...(input?.dialogTimeout === undefined
        ? {}
        : { PI_ADAPTER_MOCK_DIALOG_TIMEOUT: String(input.dialogTimeout) }),
      ...(input?.dialogCrash ? { PI_ADAPTER_MOCK_DIALOG_CRASH: "1" } : {}),
      ...(input?.permissionTool ? { PI_ADAPTER_MOCK_PERMISSION_TOOL: input.permissionTool } : {}),
      ...(input?.forkCancel ? { PI_ADAPTER_MOCK_FORK_CANCEL: "1" } : {}),
      ...(input?.forkDialog ? { PI_ADAPTER_MOCK_FORK_DIALOG: "1" } : {}),
      ...(input?.entries ? { PI_ADAPTER_MOCK_ENTRIES: JSON.stringify(input.entries) } : {}),
      ...(input?.uiEvents ? { PI_ADAPTER_MOCK_UI_EVENTS: "1" } : {}),
      ...(input?.logPath ? { PI_ADAPTER_MOCK_LOG: input.logPath } : {}),
    },
    instanceId,
    settings: {
      enabled: true,
      binaryPath: process.execPath,
      agentDir: "",
      launchArgs: "",
    },
    ...(input?.nativeRecords
      ? {
          nativeEventLogger: {
            filePath: "/mock/native.ndjson",
            write: (event: unknown) =>
              Effect.sync(() => {
                input.nativeRecords!.push(event);
              }),
            close: () => Effect.void,
          },
        }
      : {}),
    binaryArgs: [mockPath],
  });
}

function startInput(
  threadId: ThreadId,
  runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access" = "full-access",
) {
  return {
    provider: PI_DRIVER_KIND,
    providerInstanceId: instanceId,
    threadId,
    cwd: process.cwd(),
    title: "T3 lifecycle test",
    modelSelection: {
      instanceId,
      model: encodePiModelSlug({ provider: "custom provider", modelId: "model/id" }),
      options: [{ id: "thinkingLevel", value: "high" }],
    },
    runtimeMode,
  };
}

const readLog = (path: string) =>
  NodeFS.readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as { kind: string; argv?: string[]; command?: Record<string, unknown> },
    );

nodeIt("PiAdapter", (it) => {
  it.effect(
    "returns connecting before a startup dialog and lets the dialog unblock readiness",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const logPath = NodePath.join(config.stateDir, "pi-startup-dialog.log");
        const adapter = yield* makeTestAdapter({ startupDialog: true, logPath });
        const threadId = ThreadId.make("pi-startup-dialog");
        const lifecycle = yield* Stream.runCollect(
          Stream.takeUntil(
            Stream.filter(adapter.streamEvents, (event) => event.type !== "user-input.requested"),
            (event) => event.type === "thread.started" && event.threadId === threadId,
          ),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        const dialog = yield* Stream.runHead(
          Stream.filter(adapter.streamEvents, (event) => event.type === "user-input.requested"),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        const session = yield* adapter.startSession(startInput(threadId));
        expect(session.status).toBe("connecting");
        expect(yield* adapter.hasSession(threadId)).toBe(true);
        expect((yield* Fiber.join(dialog))._tag).toBe("Some");
        yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("startup-dialog"), {
          "startup-dialog": "Yes",
        });

        const events = Array.from(yield* Fiber.join(lifecycle));
        expect(events.map((event) => event.type)).toEqual([
          "user-input.resolved",
          "session.started",
          "session.configured",
          "session.state.changed",
          "thread.started",
        ]);
        expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
        expect(
          readLog(logPath).find(
            (entry) => entry.kind === "command" && entry.command?.type === "extension_ui_response",
          )?.command,
        ).toMatchObject({ confirmed: true });
      }).pipe(Effect.scoped),
  );

  it.effect("bridges select, input, and editor dialogs with exact native responses", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      for (const [method, answer] of [
        ["select", "Beta"],
        ["input", "typed value"],
        ["editor", "edited\ntext"],
      ] as const) {
        const logPath = NodePath.join(config.stateDir, `pi-${method}-dialog.log`);
        const adapter = yield* makeTestAdapter({ startupDialog: method, logPath });
        const threadId = ThreadId.make(`pi-${method}-dialog`);
        const requested = yield* Stream.runHead(
          Stream.filter(adapter.streamEvents, (event) => event.type === "user-input.requested"),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        const resolved = yield* Stream.runHead(
          Stream.filter(adapter.streamEvents, (event) => event.type === "user-input.resolved"),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* adapter.startSession(startInput(threadId));
        const opened = yield* Fiber.join(requested);
        expect(opened._tag).toBe("Some");
        yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("startup-dialog"), {
          "startup-dialog": answer,
        });
        expect((yield* Fiber.join(resolved))._tag).toBe("Some");
        yield* adapter.stopSession(threadId);
        const response = readLog(logPath)
          .filter((entry) => entry.kind === "command")
          .map((entry) => entry.command)
          .find((command) => command?.type === "extension_ui_response");
        expect(response).toMatchObject({
          type: "extension_ui_response",
          id: "startup-dialog",
          value: answer,
        });
      }
    }).pipe(Effect.scoped),
  );

  it.effect("resolves a timed dialog once without racing a native response", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter({ startupDialog: "input", dialogTimeout: 1_000 });
      const threadId = ThreadId.make("pi-timeout-dialog");
      const dialogEvents = Stream.filter(
        adapter.streamEvents,
        (event) =>
          event.threadId === threadId &&
          (event.type === "user-input.requested" || event.type === "user-input.resolved"),
      );
      const events = yield* Stream.runCollect(Stream.take(dialogEvents, 2)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const requested = yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "user-input.requested"),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* adapter.startSession(startInput(threadId));
      yield* Fiber.join(requested);
      yield* TestClock.adjust("1 second");
      expect(Array.from(yield* Fiber.join(events)).map((event) => event.type)).toEqual([
        "user-input.requested",
        "user-input.resolved",
      ]);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("clears pending dialogs when the Pi process exits", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter({ startupDialog: "editor", dialogCrash: true });
      const threadId = ThreadId.make("pi-dialog-crash");
      const terminal = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(
            adapter.streamEvents,
            (event) =>
              event.threadId === threadId &&
              (event.type === "user-input.requested" ||
                event.type === "user-input.resolved" ||
                event.type === "runtime.error" ||
                event.type === "session.exited"),
          ),
          4,
        ),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* adapter.startSession(startInput(threadId));
      expect(Array.from(yield* Fiber.join(terminal)).map((event) => event.type)).toEqual([
        "user-input.requested",
        "user-input.resolved",
        "runtime.error",
        "session.exited",
      ]);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("bounds fire-and-forget UI and deduplicates editor suggestions", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter({ uiEvents: true });
      const threadId = ThreadId.make("pi-ui-events");
      yield* adapter.startSession(startInput(threadId));
      const warnings = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(
            adapter.streamEvents,
            (event) => event.threadId === threadId && event.type === "runtime.warning",
          ),
          2,
        ),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* adapter.sendTurn({ threadId, input: "ui-events" });
      const events = Array.from(yield* Fiber.join(warnings));
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: "runtime.warning",
        payload: { message: "Extension warning", detail: { severity: "error" } },
      });
      expect(events[1]).toMatchObject({
        type: "runtime.warning",
        payload: {
          message: "A Pi extension suggested editor text.",
          detail: { suggestion: "Suggested prompt" },
        },
      });
      yield* adapter.interruptTurn(threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("routes marked permission selects through canonical approvals", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const logPath = NodePath.join(config.stateDir, "pi-permission.log");
      const adapter = yield* makeTestAdapter({ permissionTool: "bash", logPath });
      const threadId = ThreadId.make("pi-permission");
      yield* adapter.startSession(startInput(threadId, "approval-required"));
      const opened = yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "request.opened"),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      const resolved = yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "request.resolved"),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* adapter.sendTurn({ threadId, input: "permission" });
      const request = yield* Fiber.join(opened);
      expect(request._tag).toBe("Some");
      if (request._tag === "Some" && request.value.type === "request.opened") {
        expect(request.value.payload).toMatchObject({
          requestType: "command_execution_approval",
          detail: "bash: test request",
          args: { toolName: "bash", input: { command: "pnpm test" } },
        });
      }
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make("permission-dialog"),
        "acceptForSession",
      );
      expect((yield* Fiber.join(resolved))._tag).toBe("Some");
      const log = readLog(logPath);
      expect(log.find((entry) => entry.kind === "argv")?.argv).toEqual(
        expect.arrayContaining([
          "--extension",
          expect.stringContaining("t3-pi-permission-gate-v1.mjs"),
        ]),
      );
      yield* adapter.interruptTurn(threadId);
      const completedLog = readLog(logPath);
      expect(
        completedLog.find(
          (entry) => entry.kind === "command" && entry.command?.type === "extension_ui_response",
        )?.command,
      ).toMatchObject({ value: "Allow for this session" });
    }).pipe(Effect.scoped),
  );

  it.effect("maps permission decline and cancellation to native select responses", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      for (const [decision, expected] of [
        ["decline", { value: "Deny" }],
        ["cancel", { cancelled: true }],
      ] as const) {
        const logPath = NodePath.join(config.stateDir, `pi-permission-${decision}.log`);
        const adapter = yield* makeTestAdapter({ permissionTool: "custom_tool", logPath });
        const threadId = ThreadId.make(`pi-permission-${decision}`);
        yield* adapter.startSession(startInput(threadId, "auto"));
        const opened = yield* Stream.runHead(
          Stream.filter(adapter.streamEvents, (event) => event.type === "request.opened"),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* adapter.sendTurn({ threadId, input: "permission" });
        yield* Fiber.join(opened);
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make("permission-dialog"),
          decision,
        );
        yield* adapter.interruptTurn(threadId);
        expect(
          readLog(logPath).find(
            (entry) => entry.kind === "command" && entry.command?.type === "extension_ui_response",
          )?.command,
        ).toMatchObject(expected);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("uses persistent and resumed launch arguments with exact model identity", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const logPath = NodePath.join(config.stateDir, "pi-launch.log");
      const adapter = yield* makeTestAdapter({ logPath });
      const firstThread = ThreadId.make("pi-new-launch");
      yield* adapter.startSession(startInput(firstThread));
      yield* adapter.sendTurn({ threadId: firstThread, input: "/instant" });
      const firstSession = (yield* adapter.listSessions())[0];
      expect(firstSession?.resumeCursor).toMatchObject({
        schemaVersion: 1,
        sessionFile: "/mock/persistent-session.jsonl",
        sessionId: "mock-persistent-session",
      });
      yield* adapter.stopSession(firstThread);

      const secondThread = ThreadId.make("pi-resume-launch");
      yield* adapter.startSession({
        ...startInput(secondThread),
        resumeCursor: firstSession?.resumeCursor,
      });
      yield* adapter.sendTurn({ threadId: secondThread, input: "/instant" });

      const launches = readLog(logPath).filter((entry) => entry.kind === "argv");
      expect(launches).toHaveLength(2);
      expect(launches[0]?.argv).toEqual(
        expect.arrayContaining([
          "--mode",
          "rpc",
          "--provider",
          "custom provider",
          "--model",
          "model/id",
          "--thinking",
          "high",
          "--name",
          "T3 lifecycle test",
        ]),
      );
      expect(launches[0]?.argv).not.toContain("--no-session");
      expect(launches[0]?.argv?.some((arg) => arg.includes("t3-pi-permission"))).toBe(false);
      expect(launches[1]?.argv).toEqual(
        expect.arrayContaining(["--session", "/mock/persistent-session.jsonl"]),
      );
      const commands = readLog(logPath)
        .filter((entry) => entry.kind === "command")
        .map((entry) => entry.command);
      expect(commands).toContainEqual(
        expect.objectContaining({
          type: "set_model",
          provider: "custom provider",
          modelId: "model/id",
        }),
      );
      expect(commands).toContainEqual(
        expect.objectContaining({ type: "set_thinking_level", level: "high" }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("rewrites a leading skill, inlines images, and settles an idle extension command", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const logPath = NodePath.join(config.stateDir, "pi-input.log");
      const nativeRecords: unknown[] = [];
      const adapter = yield* makeTestAdapter({ logPath, nativeRecords });
      const threadId = ThreadId.make("pi-input");
      yield* adapter.startSession(startInput(threadId));
      const instantCompletion = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(
            adapter.streamEvents,
            (event) => event.type === "turn.started" || event.type === "turn.completed",
          ),
          2,
        ),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* adapter.sendTurn({ threadId, input: "/instant" });
      expect(Array.from(yield* Fiber.join(instantCompletion)).map((event) => event.type)).toEqual([
        "turn.started",
        "turn.completed",
      ]);

      const completion = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(
            adapter.streamEvents,
            (event) => event.type === "turn.started" || event.type === "turn.aborted",
          ),
          2,
        ),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      const imageId = "pi-input-00000000-0000-4000-8000-000000000001";
      NodeFS.writeFileSync(NodePath.join(config.attachmentsDir, `${imageId}.png`), "pixels");
      yield* adapter.sendTurn({
        threadId,
        input: "$test inspect this",
        attachments: [
          {
            type: "image",
            id: imageId,
            name: "test.png",
            mimeType: "image/png",
            sizeBytes: 6,
          },
        ],
      });
      yield* adapter.interruptTurn(threadId);
      const events = Array.from(yield* Fiber.join(completion));
      expect(events[0]?.type).toBe("turn.started");
      expect(events[1]?.type).toBe("turn.aborted");

      const prompt = readLog(logPath)
        .filter((entry) => entry.kind === "command")
        .map((entry) => entry.command)
        .find((command) => command?.type === "prompt" && command.message !== "/instant");
      expect(prompt?.message).toBe("/skill:test inspect this");
      const encodedPixels = Buffer.from("pixels").toString("base64");
      expect(prompt?.images).toEqual([
        { type: "image", data: encodedPixels, mimeType: "image/png" },
      ]);
      const encodedNativeRecords = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Unknown),
      )(nativeRecords);
      expect(encodedNativeRecords).not.toContain(encodedPixels);
    }).pipe(Effect.scoped),
  );

  it.effect("translates assistant, reasoning, arbitrary tools, usage, and settlement", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter();
      const threadId = ThreadId.make("pi-runtime-events");
      yield* adapter.startSession(startInput(threadId));
      const observed = yield* Stream.runCollect(
        Stream.takeUntil(
          Stream.filter(adapter.streamEvents, (event) => event.threadId === threadId),
          (event) => event.type === "turn.completed",
        ),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      const usageReconciliation = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(
            adapter.streamEvents,
            (event) => event.threadId === threadId && event.type === "thread.token-usage.updated",
          ),
          2,
        ),
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* adapter.sendTurn({ threadId, input: "events" });
      const events = Array.from(yield* Fiber.join(observed));
      const usageEvents = Array.from(yield* Fiber.join(usageReconciliation));
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      expect(
        events.some(
          (event) =>
            event.type === "content.delta" &&
            event.payload.streamKind === "assistant_text" &&
            event.payload.delta === " answer",
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
        ),
      ).toBe(true);
      const tool = events.find(
        (event) => event.type === "item.completed" && event.itemId === "mock-extension-tool",
      );
      expect(tool).toMatchObject({
        type: "item.completed",
        providerInstanceId: instanceId,
        payload: { itemType: "dynamic_tool_call", status: "completed" },
      });
      expect(events.some((event) => event.type === "thread.token-usage.updated")).toBe(true);
      expect(
        usageEvents.some(
          (event) =>
            event.type === "thread.token-usage.updated" &&
            event.payload.usage.totalProcessedTokens === 130,
        ),
      ).toBe(true);
      expect(events.every((event) => event.providerInstanceId === instanceId)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("reuses the active turn for steer and follow-up, then interrupts once", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const logPath = NodePath.join(config.stateDir, "pi-continuation.log");
      const adapter = yield* makeTestAdapter({ logPath });
      const threadId = ThreadId.make("pi-continuation");
      yield* adapter.startSession(startInput(threadId));
      const first = yield* adapter.sendTurn({ threadId, input: "hold" });
      const steered = yield* adapter.sendTurn({
        threadId,
        input: "steer me",
        interactionMode: "default",
      });
      const followed = yield* adapter.sendTurn({
        threadId,
        input: "afterward",
        interactionMode: "plan",
      });
      expect(steered.turnId).toBe(first.turnId);
      expect(followed.turnId).toBe(first.turnId);

      const aborted = yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "turn.aborted"),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* adapter.interruptTurn(threadId, first.turnId);
      yield* adapter.interruptTurn(threadId, first.turnId);
      expect((yield* Fiber.join(aborted))._tag).toBe("Some");

      const types = readLog(logPath)
        .filter((entry) => entry.kind === "command")
        .map((entry) => entry.command?.type);
      expect(types).toContain("steer");
      expect(types).toContain("follow_up");
      expect(types.filter((type) => type === "abort")).toHaveLength(1);
      expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
      const snapshot = yield* adapter.readThread(threadId);
      expect(snapshot.turns).toHaveLength(1);
      expect(snapshot.turns[0]?.items).toHaveLength(3);

      const nextCompletion = yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "turn.completed"),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      const next = yield* adapter.sendTurn({ threadId, input: "events" });
      const completion = yield* Fiber.join(nextCompletion);
      expect(completion._tag).toBe("Some");
      if (completion._tag === "Some") expect(completion.value.turnId).toBe(next.turnId);
    }).pipe(Effect.scoped),
  );

  it.effect("switches model and thinking level in-session", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const logPath = NodePath.join(config.stateDir, "pi-model-switch.log");
      const adapter = yield* makeTestAdapter({ logPath });
      const threadId = ThreadId.make("pi-model-switch");
      yield* adapter.startSession(startInput(threadId));
      yield* adapter.sendTurn({ threadId, input: "/instant" });
      yield* adapter.sendTurn({
        threadId,
        input: "/instant again",
        modelSelection: {
          instanceId,
          model: encodePiModelSlug({ provider: "another/provider", modelId: "next model" }),
          options: [{ id: "thinkingLevel", value: "max" }],
        },
      });

      const commands = readLog(logPath)
        .filter((entry) => entry.kind === "command")
        .map((entry) => entry.command);
      expect(commands).toContainEqual(
        expect.objectContaining({
          type: "set_model",
          provider: "another/provider",
          modelId: "next model",
        }),
      );
      expect(commands).toContainEqual(
        expect.objectContaining({ type: "set_thinking_level", level: "max" }),
      );
      expect((yield* adapter.listSessions())[0]?.model).toBe(
        encodePiModelSlug({ provider: "another/provider", modelId: "next model" }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("rejects unsupported cursors and never adopts a different resumed session", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter();
      const invalidThread = ThreadId.make("pi-invalid-cursor");
      const invalid = yield* adapter
        .startSession({
          ...startInput(invalidThread),
          resumeCursor: {
            schemaVersion: 99,
            sessionFile: "/mock/persistent-session.jsonl",
            sessionId: "mock-persistent-session",
          },
        })
        .pipe(Effect.flip);
      expect(invalid._tag).toBe("ProviderAdapterValidationError");
      expect(invalid.message).toContain("recovery cannot continue safely");

      const mismatchThread = ThreadId.make("pi-mismatched-resume");
      yield* adapter.startSession({
        ...startInput(mismatchThread),
        resumeCursor: {
          schemaVersion: 1,
          sessionFile: "/mock/persistent-session.jsonl",
          sessionId: "different-session",
          leafId: null,
          lastEntryId: null,
        },
      });
      const mismatch = yield* adapter
        .sendTurn({ threadId: mismatchThread, input: "complete" })
        .pipe(Effect.flip);
      expect(mismatch.message).toContain("different session");
      expect(yield* adapter.hasSession(mismatchThread)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("recovers the exact active Pi branch and reconstructs minimal turn snapshots", () =>
    Effect.gen(function* () {
      const entries = [
        {
          type: "message",
          id: "leaf-1",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "first", timestamp: 1 },
        },
        {
          type: "message",
          id: "leaf-2",
          parentId: "leaf-1",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: "second", timestamp: 2 },
        },
      ];
      const adapter = yield* makeTestAdapter({ entries });
      const threadId = ThreadId.make("pi-recovered-branch");
      yield* adapter.startSession({
        ...startInput(threadId),
        resumeCursor: {
          schemaVersion: 1,
          sessionFile: "/mock/persistent-session.jsonl",
          sessionId: "mock-persistent-session",
          leafId: "leaf-2",
          lastEntryId: "leaf-2",
        },
      });
      const snapshot = yield* adapter.readThread(threadId);
      expect(snapshot.turns).toHaveLength(2);
      expect(snapshot.turns.map((turn) => turn.items[0])).toEqual([
        { role: "user", text: "first", recovered: true },
        { role: "user", text: "second", recovered: true },
      ]);

      const rolledBack = yield* adapter.rollbackThread(threadId, 1);
      expect(rolledBack.turns).toHaveLength(1);
      expect((yield* adapter.listSessions())[0]?.resumeCursor).toMatchObject({
        sessionFile: "/mock/fork-1.jsonl",
        sessionId: "mock-fork-1",
        leafId: "leaf-1",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("tracks stable turn snapshots and forks before the earliest rolled-back turn", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const logPath = NodePath.join(config.stateDir, "pi-rollback.log");
      const adapter = yield* makeTestAdapter({ logPath });
      const threadId = ThreadId.make("pi-rollback");
      yield* adapter.startSession(startInput(threadId));

      for (const text of ["complete one", "complete two", "complete three"]) {
        const completed = yield* Stream.runHead(
          Stream.filter(
            adapter.streamEvents,
            (event) => event.threadId === threadId && event.type === "turn.completed",
          ),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* adapter.sendTurn({ threadId, input: text });
        yield* Fiber.join(completed);
      }

      const before = yield* adapter.readThread(threadId);
      expect(before.turns).toHaveLength(3);
      const rolledBack = yield* adapter.rollbackThread(threadId, 2);
      expect(rolledBack.turns.map((turn) => turn.id)).toEqual([before.turns[0]?.id]);
      expect((yield* adapter.listSessions())[0]?.resumeCursor).toMatchObject({
        schemaVersion: 1,
        sessionFile: "/mock/fork-1.jsonl",
        sessionId: "mock-fork-1",
        leafId: "leaf-1",
        lastEntryId: "leaf-1",
      });
      const fork = readLog(logPath)
        .filter((entry) => entry.kind === "command")
        .map((entry) => entry.command)
        .find((command) => command?.type === "fork");
      expect(fork).toMatchObject({ type: "fork", entryId: "leaf-2" });
    }).pipe(Effect.scoped),
  );

  it.effect("leaves snapshots and the cursor untouched when a Pi extension cancels fork", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter({ forkCancel: true });
      const threadId = ThreadId.make("pi-rollback-cancelled");
      yield* adapter.startSession(startInput(threadId));
      const completed = yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "turn.completed"),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* adapter.sendTurn({ threadId, input: "complete once" });
      yield* Fiber.join(completed);
      const beforeSnapshot = yield* adapter.readThread(threadId);
      const beforeCursor = (yield* adapter.listSessions())[0]?.resumeCursor;

      const failure = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
      expect(failure.message).toContain("session_before_fork");
      expect(yield* adapter.readThread(threadId)).toEqual(beforeSnapshot);
      expect((yield* adapter.listSessions())[0]?.resumeCursor).toEqual(beforeCursor);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps extension lifecycle dialogs routable while native fork is pending", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter({ forkDialog: true });
      const threadId = ThreadId.make("pi-rollback-dialog");
      yield* adapter.startSession(startInput(threadId));
      const completed = yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "turn.completed"),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* adapter.sendTurn({ threadId, input: "complete once" });
      yield* Fiber.join(completed);

      const requested = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event) =>
            event.threadId === threadId &&
            event.type === "user-input.requested" &&
            event.requestId === "fork-dialog",
        ),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      const rollback = yield* adapter
        .rollbackThread(threadId, 1)
        .pipe(Effect.forkChild({ startImmediately: true }));
      expect((yield* Fiber.join(requested))._tag).toBe("Some");
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("fork-dialog"), {
        "fork-dialog": "Yes",
      });
      expect((yield* Fiber.join(rollback)).turns).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("refreshes the durable cursor after an extension replaces the Pi session", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter();
      const threadId = ThreadId.make("pi-extension-switch");
      yield* adapter.startSession(startInput(threadId));
      yield* adapter.sendTurn({ threadId, input: "/switch" });
      expect((yield* adapter.listSessions())[0]?.resumeCursor).toMatchObject({
        sessionFile: "/mock/extension-session.jsonl",
        sessionId: "mock-extension-session",
        leafId: null,
        lastEntryId: null,
      });
      expect((yield* adapter.readThread(threadId)).turns).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("fails an active turn once when the owned process crashes", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter();
      const threadId = ThreadId.make("pi-crash");
      yield* adapter.startSession(startInput(threadId));
      yield* adapter.sendTurn({ threadId, input: "/instant" });
      const terminal = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(
            adapter.streamEvents,
            (event) =>
              event.type === "turn.completed" ||
              event.type === "runtime.error" ||
              event.type === "session.exited",
          ),
          3,
        ),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* adapter.sendTurn({ threadId, input: "crash" });
      const events = Array.from(yield* Fiber.join(terminal));
      expect(events.map((event) => event.type)).toEqual([
        "turn.completed",
        "runtime.error",
        "session.exited",
      ]);
      expect(events[0]?.type === "turn.completed" && events[0].payload.state).toBe("failed");
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps threads isolated and stopAll is idempotent", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter();
      const one = ThreadId.make("pi-one");
      const two = ThreadId.make("pi-two");
      yield* adapter.startSession(startInput(one));
      yield* adapter.startSession(startInput(two));
      yield* Effect.all([
        adapter.sendTurn({ threadId: one, input: "/instant" }),
        adapter.sendTurn({ threadId: two, input: "/instant" }),
      ]);
      expect(yield* adapter.listSessions()).toHaveLength(2);
      yield* adapter.stopAll();
      yield* adapter.stopAll();
      expect(yield* adapter.listSessions()).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
