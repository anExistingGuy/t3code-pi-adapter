// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  materializePiPermissionExtension,
  PI_PERMISSION_CWD_ENV,
  PI_PERMISSION_EXTENSION_FILE,
  PI_PERMISSION_EXTENSION_SOURCE,
  PI_PERMISSION_MARKER_ENV,
  PI_PERMISSION_MODE_ENV,
  PI_PERMISSION_OPTIONS,
  PI_PERMISSION_PROTOCOL_ENV,
  PI_PERMISSION_PROTOCOL_VERSION,
  piPermissionGateRequired,
} from "./PiPermissionExtension.ts";

type ToolHandler = (
  event: { toolName: string; toolCallId: string; input: unknown },
  context: {
    hasUI: boolean;
    ui: { select: (title: string, options: ReadonlyArray<string>) => Promise<string | undefined> };
  },
) => Promise<{ block: true; reason: string } | undefined>;

type ExtensionFactory = (pi: { on: (event: "tool_call", handler: ToolHandler) => void }) => void;

const loadFactory = async () => {
  const url = `data:text/javascript;base64,${Buffer.from(PI_PERMISSION_EXTENSION_SOURCE).toString("base64")}`;
  return (await import(url)).default as ExtensionFactory;
};

async function makeHandler(mode: string, select: () => Promise<string | undefined>) {
  process.env[PI_PERMISSION_MARKER_ENV] = "test-marker";
  process.env[PI_PERMISSION_MODE_ENV] = mode;
  process.env[PI_PERMISSION_CWD_ENV] = "/workspace";
  process.env[PI_PERMISSION_PROTOCOL_ENV] = PI_PERMISSION_PROTOCOL_VERSION;
  let handler: ToolHandler | undefined;
  (await loadFactory())({
    on: (_event, registered) => {
      handler = registered;
    },
  });
  if (!handler) throw new Error("Permission extension did not register its handler.");
  return (toolName: string, input: unknown = {}) =>
    handler!(
      { toolName, toolCallId: `${toolName}-1`, input },
      {
        hasUI: true,
        ui: {
          select: (_title, options) =>
            select().then((value) => {
              expect(options).toEqual(PI_PERMISSION_OPTIONS);
              return value;
            }),
        },
      },
    );
}

describe("Pi permission extension", () => {
  it("is absent only for full access", () => {
    expect(piPermissionGateRequired("full-access")).toBe(false);
    expect(piPermissionGateRequired("approval-required")).toBe(true);
    expect(piPermissionGateRequired("auto-accept-edits")).toBe(true);
    expect(piPermissionGateRequired("auto")).toBe(true);
  });

  it("asks conservatively and auto-accepts edits only in edit mode", async () => {
    let prompts = 0;
    const supervised = await makeHandler("approval-required", async () => {
      prompts += 1;
      return PI_PERMISSION_OPTIONS[0];
    });
    expect(await supervised("read", { path: "README.md" })).toBeUndefined();
    expect(await supervised("edit", { path: "src/a.ts" })).toBeUndefined();
    expect(await supervised("custom_network_tool")).toBeUndefined();
    expect(prompts).toBe(2);

    prompts = 0;
    const editMode = await makeHandler("auto-accept-edits", async () => {
      prompts += 1;
      return PI_PERMISSION_OPTIONS[0];
    });
    expect(await editMode("edit")).toBeUndefined();
    expect(await editMode("bash", { command: "pnpm test" })).toBeUndefined();
    expect(prompts).toBe(1);
  });

  it("supports session grants, denial, cancellation, and instance isolation", async () => {
    let prompts = 0;
    const first = await makeHandler("auto", async () => {
      prompts += 1;
      return PI_PERMISSION_OPTIONS[1];
    });
    expect(await first("unknown_tool")).toBeUndefined();
    expect(await first("unknown_tool")).toBeUndefined();
    expect(prompts).toBe(1);

    const second = await makeHandler("auto", async () => PI_PERMISSION_OPTIONS[2]);
    expect(await second("unknown_tool")).toMatchObject({ block: true });
    const cancelled = await makeHandler("auto", async () => undefined);
    expect(await cancelled("bash")).toMatchObject({ block: true });
  });

  it.effect("materializes a stable production asset under T3 state", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync("/tmp/t3-pi-permission-")),
        (directory) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const path = yield* materializePiPermissionExtension(root);
      expect(path.endsWith(PI_PERMISSION_EXTENSION_FILE)).toBe(true);
      expect(NodeFS.readFileSync(path, "utf8")).toBe(PI_PERMISSION_EXTENSION_SOURCE);
      expect(yield* materializePiPermissionExtension(root)).toBe(path);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
