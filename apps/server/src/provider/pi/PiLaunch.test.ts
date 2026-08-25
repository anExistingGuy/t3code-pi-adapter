import { describe, expect, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";

import { buildPiLaunchSpec, resolvePiLaunch, validatePiLaunchArgs } from "./PiLaunch.ts";

describe("Pi launch policy", () => {
  it("builds deterministic persistent, resumed, and ephemeral RPC arguments", () => {
    const base = {
      binaryPath: "pi",
      launchArgs: "--verbose --extension ./extension.ts",
      cwd: "/workspace",
      env: { PATH: "/bin" },
    } as const;

    expect(buildPiLaunchSpec({ ...base, session: { mode: "persistent" } }).args).toEqual([
      "--verbose",
      "--extension",
      "./extension.ts",
      "--mode",
      "rpc",
    ]);
    const resumedArgs = buildPiLaunchSpec({
      ...base,
      session: { mode: "resume", sessionFile: "/sessions/a.jsonl" },
    }).args;
    const sessionIndex = resumedArgs.indexOf("--session");
    expect(resumedArgs.slice(sessionIndex, sessionIndex + 2)).toEqual([
      "--session",
      "/sessions/a.jsonl",
    ]);
    expect(buildPiLaunchSpec({ ...base, session: { mode: "ephemeral" } }).args).toContain(
      "--no-session",
    );
  });

  it("preserves exact model identity and appends adapter-owned options", () => {
    const spec = buildPiLaunchSpec({
      binaryPath: "custom-pi",
      launchArgs: "--verbose",
      cwd: "/workspace",
      env: { CUSTOM: "yes" },
      session: { mode: "ephemeral" },
      model: { provider: "custom/provider", id: "model/id with spaces" },
      thinkingLevel: "xhigh",
      sessionName: " T3 session ",
    });

    expect(spec).toMatchObject({
      command: "custom-pi",
      cwd: "/workspace",
      env: { CUSTOM: "yes" },
    });
    expect(spec.args).toEqual([
      "--verbose",
      "--mode",
      "rpc",
      "--no-session",
      "--provider",
      "custom/provider",
      "--model",
      "model/id with spaces",
      "--thinking",
      "xhigh",
      "--name",
      "T3 session",
    ]);
  });

  it("rejects adapter-owned flags and positional prompts", () => {
    expect(validatePiLaunchArgs("--provider custom")).toContain("--provider");
    expect(validatePiLaunchArgs("--mode=rpc")).toContain("--mode");
    expect(validatePiLaunchArgs("--name custom")).toContain("--name");
    expect(validatePiLaunchArgs("hello")).toContain("initial prompt");
    expect(validatePiLaunchArgs("--verbose")).toBeUndefined();
  });

  it.effect("resolves and escapes Windows command shims", () =>
    resolvePiLaunch({
      binaryPath: "pi",
      launchArgs: "",
      cwd: "C:\\workspace",
      env: { PATH: "C:\\Users\\tester\\AppData\\Roaming\\npm" },
      session: { mode: "ephemeral" },
      model: { provider: "custom provider", id: "model & release" },
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(HostProcessEnvironment, {
        PATH: "C:\\Users\\tester\\AppData\\Roaming\\npm",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      }),
      Effect.provideService(
        SpawnExecutableResolution,
        () => "C:\\Users\\tester\\AppData\\Roaming\\npm\\pi.cmd",
      ),
      Effect.map((launch) => {
        expect(launch.shell).toBe(true);
        expect(launch.command).toContain("pi.cmd");
        expect(launch.args.join(" ")).toContain("custom^ provider");
        expect(launch.args.join(" ")).toContain("model^ ^&^ release");
      }),
    ),
  );
});
