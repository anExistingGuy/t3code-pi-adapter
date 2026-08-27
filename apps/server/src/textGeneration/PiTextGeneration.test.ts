// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off cryptoRandomUUIDInEffect:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { PiSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { encodePiModelSlug } from "../provider/pi/PiModelCatalog.ts";
import { makePiTextGeneration } from "./PiTextGeneration.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPath = NodePath.join(__dirname, "../../scripts/pi-text-generation-mock-agent.mjs");
const instanceId = ProviderInstanceId.make("pi_text_test");
const decodeSettings = Schema.decodeSync(PiSettings);
const settings = decodeSettings({ enabled: true, binaryPath: process.execPath });
const selection = (options?: ReadonlyArray<{ readonly id: string; readonly value: string }>) =>
  createModelSelection(
    instanceId,
    encodePiModelSlug({ provider: "extension/custom provider", modelId: "model/id with spaces" }),
    options,
  );

const TestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeService(
  environment: NodeJS.ProcessEnv = {},
  options: {
    readonly timeoutMs?: number;
    readonly onRuntimeReady?: () => Effect.Effect<void, never>;
  } = {},
) {
  return makePiTextGeneration({
    instanceId,
    settings,
    environment: { ...process.env, ...environment },
    options: { binaryArgs: [mockPath], ...options },
  });
}

function readLog(filePath: string): ReadonlyArray<Record<string, unknown>> {
  const raw = NodeFS.readFileSync(filePath, "utf8").trim();
  return raw ? raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

it.layer(TestLayer)("PiTextGeneration", (it) => {
  it.effect("generates all four result shapes with shared prompts and sanitizers", () =>
    Effect.gen(function* () {
      const commit = yield* makeService({
        PI_TEXT_MOCK_OUTPUT: JSON.stringify({
          subject: "Update Pi generation.",
          body: "  Body  ",
          branch: "Feature/Pi Generation",
        }),
      });
      expect(
        yield* commit.generateCommitMessage({
          cwd: process.cwd(),
          branch: "main",
          stagedSummary: "M file.ts",
          stagedPatch: "+change",
          includeBranch: true,
          modelSelection: selection(),
        }),
      ).toEqual({ subject: "Update Pi generation", body: "Body", branch: "feature/pi-generation" });

      const pr = yield* makeService({
        PI_TEXT_MOCK_OUTPUT: JSON.stringify({
          title: " Add Pi generation ",
          body: "  ## Summary\n- Pi  ",
        }),
      });
      expect(
        yield* pr.generatePrContent({
          cwd: process.cwd(),
          baseBranch: "main",
          headBranch: "pi",
          commitSummary: "commit",
          diffSummary: "file",
          diffPatch: "+change",
          modelSelection: selection(),
        }),
      ).toEqual({ title: "Add Pi generation", body: "## Summary\n- Pi" });

      const branch = yield* makeService({ PI_TEXT_MOCK_OUTPUT: '{"branch":"Fix Pi Titles"}' });
      expect(
        yield* branch.generateBranchName({
          cwd: process.cwd(),
          message: "fix titles",
          modelSelection: selection(),
        }),
      ).toEqual({ branch: "fix-pi-titles" });

      const title = yield* makeService({
        PI_TEXT_MOCK_OUTPUT: '{"title":"  Improve Pi Titles  "}',
      });
      expect(
        yield* title.generateThreadTitle({
          cwd: process.cwd(),
          message: "fix titles",
          modelSelection: selection(),
        }),
      ).toEqual({ title: "Improve Pi Titles" });
    }),
  );

  it.effect(
    "launches an isolated no-session/no-tools process with exact custom model and thinking",
    () =>
      Effect.gen(function* () {
        const logPath = NodePath.join(
          NodeOS.tmpdir(),
          `pi-text-launch-${crypto.randomUUID()}.jsonl`,
        );
        const service = yield* makeService({
          PI_TEXT_MOCK_LOG: logPath,
          PI_TEXT_MOCK_OUTPUT: '{"title":"Exact model"}',
        });
        yield* service.generateThreadTitle({
          cwd: process.cwd(),
          message: "title",
          modelSelection: selection([{ id: "thinkingLevel", value: "high" }]),
        });

        const records = readLog(logPath);
        const argv = records.find((record) => record.kind === "argv")?.argv as string[];
        expect(argv).toContain("--no-session");
        expect(argv).toContain("--no-tools");
        expect(argv.slice(argv.indexOf("--provider"), argv.indexOf("--provider") + 2)).toEqual([
          "--provider",
          "extension/custom provider",
        ]);
        expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2)).toEqual([
          "--model",
          "model/id with spaces",
        ]);
        expect(argv.slice(argv.indexOf("--thinking"), argv.indexOf("--thinking") + 2)).toEqual([
          "--thinking",
          "high",
        ]);
        const commands = records
          .filter((record) => record.kind === "command")
          .map(
            (record) =>
              record.command as {
                type: string;
                provider?: string;
                modelId?: string;
                level?: string;
              },
          );
        expect(commands).toContainEqual(
          expect.objectContaining({
            type: "set_model",
            provider: "extension/custom provider",
            modelId: "model/id with spaces",
          }),
        );
        expect(commands).toContainEqual(
          expect.objectContaining({ type: "set_thinking_level", level: "high" }),
        );
      }),
  );

  it.effect("auto-cancels extension dialogs and trusts authoritative final text over deltas", () =>
    Effect.gen(function* () {
      const logPath = NodePath.join(NodeOS.tmpdir(), `pi-text-dialog-${crypto.randomUUID()}.jsonl`);
      const service = yield* makeService({
        PI_TEXT_MOCK_LOG: logPath,
        PI_TEXT_MOCK_DIALOG: "1",
        PI_TEXT_MOCK_DELTA: '{"title":"Streaming title"}',
        PI_TEXT_MOCK_OUTPUT: '{"title":"Authoritative title"}',
      });
      const result = yield* service.generateThreadTitle({
        cwd: process.cwd(),
        message: "title",
        modelSelection: selection(),
      });
      expect(result.title).toBe("Authoritative title");
      expect(
        readLog(logPath).some((record) => {
          const command = record.command as { type?: string; id?: string; cancelled?: boolean };
          return (
            command?.type === "extension_ui_response" &&
            command.id === "prompt-dialog" &&
            command.cancelled
          );
        }),
      ).toBe(true);
    }),
  );

  it.effect("extracts fenced JSON and rejects malformed structured output without echoing it", () =>
    Effect.gen(function* () {
      const fenced = yield* makeService({
        PI_TEXT_MOCK_OUTPUT: '```json\n{"branch":"pi utility output"}\n```',
      });
      expect(
        yield* fenced.generateBranchName({
          cwd: process.cwd(),
          message: "branch",
          modelSelection: selection(),
        }),
      ).toEqual({ branch: "pi-utility-output" });

      const secret = "DIFF_SECRET_SHOULD_NOT_BE_ECHOED";
      const malformed = yield* makeService({ PI_TEXT_MOCK_OUTPUT: `${secret} not-json` });
      const error = yield* Effect.flip(
        malformed.generateThreadTitle({
          cwd: process.cwd(),
          message: "title",
          modelSelection: selection(),
        }),
      );
      expect(error.detail).toContain("invalid structured output");
      expect(error.detail).not.toContain(secret);
    }),
  );

  it.effect("maps aborted, error, empty, crash, and timeout outcomes to typed errors", () =>
    Effect.gen(function* () {
      for (const behavior of ["aborted", "error", "empty", "crash"] as const) {
        const service = yield* makeService({ PI_TEXT_MOCK_BEHAVIOR: behavior });
        const error = yield* Effect.flip(
          service.generateThreadTitle({
            cwd: process.cwd(),
            message: "title",
            modelSelection: selection(),
          }),
        );
        expect(error._tag, behavior).toBe("TextGenerationError");
      }

      const logPath = NodePath.join(
        NodeOS.tmpdir(),
        `pi-text-timeout-${crypto.randomUUID()}.jsonl`,
      );
      const timed = yield* makeService(
        { PI_TEXT_MOCK_BEHAVIOR: "hang", PI_TEXT_MOCK_LOG: logPath },
        { timeoutMs: 500 },
      );
      const timeout = yield* Effect.flip(
        timed.generateThreadTitle({
          cwd: process.cwd(),
          message: "title",
          modelSelection: selection(),
        }),
      );
      expect(timeout.detail).toContain("timed out");
      expect(readLog(logPath).some((record) => record.kind === "closed")).toBe(true);
    }).pipe(TestClock.withLive),
  );

  it.effect("closes the owned child when the caller cancels", () =>
    Effect.gen(function* () {
      const logPath = NodePath.join(NodeOS.tmpdir(), `pi-text-cancel-${crypto.randomUUID()}.jsonl`);
      const ready = yield* Deferred.make<void>();
      const service = yield* makeService(
        {
          PI_TEXT_MOCK_BEHAVIOR: "hang",
          PI_TEXT_MOCK_LOG: logPath,
        },
        { onRuntimeReady: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid) },
      );
      const fiber = yield* service
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "title",
          modelSelection: selection(),
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      expect(readLog(logPath).some((record) => record.kind === "closed")).toBe(true);
    }),
  );

  it.effect("encodes image attachments only on the RPC command and not in diagnostics", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const attachmentId = "pi-text-image";
      const imageBytes = Buffer.from("private-pixels");
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fs.writeFile(NodePath.join(config.attachmentsDir, `${attachmentId}.png`), imageBytes);
      const logPath = NodePath.join(NodeOS.tmpdir(), `pi-text-image-${crypto.randomUUID()}.jsonl`);
      const service = yield* makeService({
        PI_TEXT_MOCK_LOG: logPath,
        PI_TEXT_MOCK_OUTPUT: '{"branch":"image fix"}',
      });
      yield* service.generateBranchName({
        cwd: process.cwd(),
        message: "fix screenshot",
        attachments: [
          {
            type: "image",
            id: attachmentId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: imageBytes.length,
          },
        ],
        modelSelection: selection(),
      });
      const records = readLog(logPath);
      const prompt = records
        .filter((record) => record.kind === "command")
        .map((record) => record.command as { type: string; images?: Array<{ data: string }> })
        .find((command) => command.type === "prompt");
      expect(prompt?.images?.[0]?.data).toBe(imageBytes.toString("base64"));
      const nonPromptRecords = records.filter(
        (record) => (record.command as { type?: string } | undefined)?.type !== "prompt",
      );
      expect(JSON.stringify(nonPromptRecords)).not.toContain(imageBytes.toString("base64"));
    }),
  );

  it.effect("uses independent processes for concurrent utility requests", () =>
    Effect.gen(function* () {
      const logPath = NodePath.join(
        NodeOS.tmpdir(),
        `pi-text-concurrent-${crypto.randomUUID()}.jsonl`,
      );
      const service = yield* makeService({
        PI_TEXT_MOCK_LOG: logPath,
        PI_TEXT_MOCK_OUTPUT: '{"title":"Concurrent Pi"}',
      });
      yield* Effect.all(
        ["one", "two"].map((message) =>
          service.generateThreadTitle({ cwd: process.cwd(), message, modelSelection: selection() }),
        ),
        { concurrency: "unbounded" },
      );
      const pids = new Set(
        readLog(logPath)
          .filter((record) => record.kind === "argv")
          .map((record) => record.pid),
      );
      expect(pids.size).toBe(2);
    }),
  );

  it.effect("rejects model selections for another Pi instance before spawning", () =>
    Effect.gen(function* () {
      const service = yield* makeService();
      const error = yield* Effect.flip(
        service.generateThreadTitle({
          cwd: process.cwd(),
          message: "title",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("other_pi"),
            encodePiModelSlug({ provider: "custom", modelId: "model" }),
          ),
        }),
      );
      expect(error.detail).toContain("other_pi");
    }),
  );
});
