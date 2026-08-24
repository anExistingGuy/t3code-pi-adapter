// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { checkPiProviderStatus } from "./PiProvider.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPath = NodePath.join(__dirname, "../../../scripts/pi-provider-probe-mock-agent.mjs");
const nodeIt = it.layer(NodeServices.layer);

const settings: PiSettings = {
  enabled: true,
  binaryPath: process.execPath,
  agentDir: "",
  launchArgs: "",
};

function piModel(input: {
  provider: string;
  id: string;
  name: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}) {
  return {
    id: input.id,
    name: input.name,
    api: "custom-api",
    provider: input.provider,
    baseUrl: "http://localhost.invalid",
    reasoning: input.reasoning ?? true,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(input.thinkingLevelMap ? { thinkingLevelMap: input.thinkingLevelMap } : {}),
  };
}

const probe = (env: NodeJS.ProcessEnv = {}, overrides: Partial<PiSettings> = {}) =>
  checkPiProviderStatus({ ...settings, ...overrides }, process.cwd(), env, {
    binaryArgs: [mockPath],
    versionTimeoutMs: 500,
    rpcTimeoutMs: 1_000,
  });

nodeIt("Pi provider discovery", (it) => {
  it.effect("discovers custom models, active thinking, commands, and scoped skills", () =>
    Effect.gen(function* () {
      const active = piModel({
        provider: "custom provider/one",
        id: "model/same",
        name: "Custom Active",
        thinkingLevelMap: { xhigh: "extra", max: "maximum" },
      });
      const other = piModel({
        provider: "other-provider",
        id: "model/same",
        name: "Other Provider Model",
      });
      const plain = piModel({
        provider: "local",
        id: "plain",
        name: "Plain",
        reasoning: false,
      });
      const commands = [
        {
          name: "extension-command",
          description: "From extension",
          source: "extension",
          sourceInfo: {
            path: "/extensions/example.ts",
            source: "settings",
            scope: "user",
            origin: "top-level",
          },
        },
        {
          name: "review",
          description: "Project prompt",
          source: "prompt",
          sourceInfo: {
            path: "/project/.pi/prompts/review.md",
            source: "project prompts",
            scope: "project",
            origin: "top-level",
          },
        },
        {
          name: "skill:pdf-tools",
          description: "PDF tools",
          source: "skill",
          sourceInfo: {
            path: "/home/user/.pi/skills/pdf/SKILL.md",
            source: "user skills",
            scope: "user",
            origin: "top-level",
          },
        },
      ];
      const snapshot = yield* probe({
        PI_MOCK_MODELS: JSON.stringify([active, other, active, plain]),
        PI_MOCK_STATE_MODEL: JSON.stringify(active),
        PI_MOCK_THINKING_LEVEL: "max",
        PI_MOCK_THINKING_LEVELS: JSON.stringify(["off", "high", "xhigh", "max"]),
        PI_MOCK_COMMANDS: JSON.stringify(commands),
        PI_MOCK_STARTUP_DIALOG: "1",
      });

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("0.52.12");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models).toHaveLength(3);
      expect(snapshot.models.map((model) => model.subProvider)).toEqual([
        "custom provider/one",
        "other-provider",
        "local",
      ]);
      expect(snapshot.models[0]?.isDefault).toBe(true);
      expect(snapshot.models[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
        id: "thinkingLevel",
        currentValue: "max",
      });
      expect(snapshot.models[2]?.capabilities?.optionDescriptors).toEqual([]);
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual([
        "extension-command",
        "review",
        "skill:pdf-tools",
      ]);
      expect(snapshot.skills).toEqual([
        expect.objectContaining({
          name: "pdf-tools",
          path: "/home/user/.pi/skills/pdf/SKILL.md",
          scope: "user",
        }),
      ]);
    }),
  );

  it.effect("returns vendor-neutral guidance when Pi reports no models", () =>
    Effect.gen(function* () {
      const snapshot = yield* probe({ PI_MOCK_NO_MODELS: "1" });
      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.models).toEqual([]);
      expect(snapshot.message).toContain("Authenticate or configure a provider in Pi");
      expect(snapshot.message).not.toContain("Anthropic");
      expect(snapshot.message).not.toContain("OpenAI");
    }),
  );

  it.effect("reports malformed and incompatible RPC catalogs without crashing", () =>
    Effect.gen(function* () {
      const malformed = yield* probe({ PI_MOCK_MALFORMED_MODEL: "1" });
      expect(malformed.status).toBe("error");
      expect(malformed.installed).toBe(true);
      expect(malformed.message).toContain("supports `--mode rpc`");

      const incompatible = yield* probe({ PI_MOCK_INCOMPATIBLE_RPC: "1" });
      expect(incompatible.status).toBe("error");
      expect(incompatible.message).toContain("get_available_models");
    }),
  );

  it.effect("distinguishes missing binaries and nonzero version probes", () =>
    Effect.gen(function* () {
      const missing = yield* checkPiProviderStatus(
        { ...settings, binaryPath: NodePath.join(process.cwd(), "missing-pi-command") },
        process.cwd(),
        {},
        { versionTimeoutMs: 500 },
      );
      expect(missing.installed).toBe(false);
      expect(missing.status).toBe("error");

      const nonzero = yield* probe({ PI_MOCK_VERSION_EXIT: "9" });
      expect(nonzero.installed).toBe(true);
      expect(nonzero.status).toBe("error");
      expect(nonzero.message).toContain("--version");
    }),
  );

  it.effect("returns actionable version and RPC timeout snapshots", () =>
    Effect.gen(function* () {
      const versionTimeout = yield* checkPiProviderStatus(
        settings,
        process.cwd(),
        {
          PI_MOCK_VERSION_HANG: "1",
        },
        {
          binaryArgs: [mockPath],
          versionTimeoutMs: 100,
          rpcTimeoutMs: 500,
        },
      );
      expect(versionTimeout.status).toBe("error");
      expect(versionTimeout.message).toContain("timed out while running `pi --version`");

      const rpcTimeout = yield* checkPiProviderStatus(
        settings,
        process.cwd(),
        {
          PI_MOCK_RPC_HANG: "1",
        },
        {
          binaryArgs: [mockPath],
          versionTimeoutMs: 500,
          rpcTimeoutMs: 100,
        },
      );
      expect(rpcTimeout.status).toBe("error");
      expect(rpcTimeout.message).toContain("RPC discovery timed out");
    }).pipe(TestClock.withLive),
  );

  it.effect("does not launch a disabled provider", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(
        { ...settings, enabled: false, binaryPath: "/definitely/not/pi" },
        process.cwd(),
        {},
        { versionTimeoutMs: 1 },
      );
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toBe("Pi is disabled in T3 Code settings.");
    }),
  );
});
