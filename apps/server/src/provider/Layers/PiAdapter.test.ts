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
  readonly startupDialog?: boolean;
  readonly logPath?: string;
  readonly nativeRecords?: unknown[];
}) {
  return makePiAdapter({
    environment: {
      ...(input?.startupDialog ? { PI_ADAPTER_MOCK_STARTUP_DIALOG: "1" } : {}),
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

function startInput(threadId: ThreadId) {
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
    runtimeMode: "full-access" as const,
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
        const adapter = yield* makeTestAdapter({ startupDialog: true });
        const threadId = ThreadId.make("pi-startup-dialog");
        const lifecycle = yield* Stream.runCollect(
          Stream.takeUntil(
            Stream.filter(adapter.streamEvents, (event) => event.type !== "request.opened"),
            (event) => event.type === "thread.started" && event.threadId === threadId,
          ),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        const dialog = yield* Stream.runHead(
          Stream.filter(adapter.streamEvents, (event) => event.type === "request.opened"),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        const session = yield* adapter.startSession(startInput(threadId));
        expect(session.status).toBe("connecting");
        expect(yield* adapter.hasSession(threadId)).toBe(true);
        expect((yield* Fiber.join(dialog))._tag).toBe("Some");
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make("startup-dialog"),
          "accept",
        );

        const events = Array.from(yield* Fiber.join(lifecycle));
        expect(events.map((event) => event.type)).toEqual([
          "session.started",
          "session.configured",
          "session.state.changed",
          "thread.started",
        ]);
        expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
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

      const completion = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
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
