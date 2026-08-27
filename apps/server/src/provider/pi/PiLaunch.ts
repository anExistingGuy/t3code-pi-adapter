import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { resolveSpawnCommand, type ResolvedSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const RESERVED_FLAGS = [
  "--mode",
  "--no-session",
  "--session",
  "--session-dir",
  "--provider",
  "--model",
  "--thinking",
  "--name",
  "-n",
  "--print",
  "-p",
] as const;

const BOOLEAN_FLAGS = new Set([
  "--verbose",
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "-nc",
  "--no-builtin-tools",
  "-nbt",
  "--no-tools",
  "-nt",
]);

export function validatePiLaunchArgs(launchArgs: string): string | undefined {
  const argv = tokenizeCliArgs(launchArgs);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    const reserved = RESERVED_FLAGS.find(
      (flag) => arg === flag || (flag.startsWith("--") && arg.startsWith(`${flag}=`)),
    );
    if (reserved !== undefined) {
      return `Launch arguments cannot set adapter-owned argument '${reserved}'.`;
    }
    if (arg === "--") {
      return "Launch arguments cannot include an initial prompt.";
    }
    if (!arg.startsWith("-")) {
      return "Launch arguments cannot include an initial prompt.";
    }
    if (!BOOLEAN_FLAGS.has(arg) && !arg.includes("=")) {
      index += 1;
    }
  }
  return undefined;
}

export class PiLaunchArgumentError extends Schema.TaggedErrorClass<PiLaunchArgumentError>()(
  "PiLaunchArgumentError",
  { detail: Schema.String },
) {}

const isPiLaunchArgumentError = Schema.is(PiLaunchArgumentError);

export type PiLaunchSession =
  | { readonly mode: "persistent" }
  | { readonly mode: "resume"; readonly sessionFile: string }
  | { readonly mode: "ephemeral" };

export interface PiLaunchInput {
  readonly binaryPath: string;
  readonly launchArgs: string;
  /** Internal executable prefix, used by probes and subprocess test fixtures. */
  readonly binaryArgs?: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Adapter-owned extensions appended without replacing user-configured extensions. */
  readonly extensionPaths?: ReadonlyArray<string>;
  readonly session: PiLaunchSession;
  readonly model?: {
    readonly provider: string;
    readonly id: string;
  };
  readonly thinkingLevel?: string;
  /** Disable every built-in, extension, and custom tool for utility processes. */
  readonly disableTools?: boolean;
  readonly sessionName?: string;
}

export interface PiLaunchSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export function buildPiLaunchSpec(input: PiLaunchInput): PiLaunchSpec {
  const issue = validatePiLaunchArgs(input.launchArgs);
  if (issue !== undefined) {
    throw new PiLaunchArgumentError({ detail: issue });
  }

  const args = [...(input.binaryArgs ?? []), ...tokenizeCliArgs(input.launchArgs)];
  for (const extensionPath of input.extensionPaths ?? []) {
    args.push("--extension", extensionPath);
  }
  args.push("--mode", "rpc");
  if (input.disableTools) {
    args.push("--no-tools");
  }
  if (input.session.mode === "ephemeral") {
    args.push("--no-session");
  } else if (input.session.mode === "resume") {
    args.push("--session", input.session.sessionFile);
  }
  if (input.model) {
    args.push("--provider", input.model.provider, "--model", input.model.id);
  }
  if (input.thinkingLevel) {
    args.push("--thinking", input.thinkingLevel);
  }
  if (input.sessionName?.trim()) {
    args.push("--name", input.sessionName.trim());
  }
  return {
    command: input.binaryPath,
    args,
    cwd: input.cwd,
    env: input.env,
  };
}

export const resolvePiLaunch = Effect.fn("resolvePiLaunch")(function* (
  input: PiLaunchInput,
): Effect.fn.Return<PiLaunchSpec & ResolvedSpawnCommand, PiLaunchArgumentError> {
  const spec = yield* Effect.try({
    try: () => buildPiLaunchSpec(input),
    catch: (cause) =>
      isPiLaunchArgumentError(cause) ? cause : new PiLaunchArgumentError({ detail: String(cause) }),
  });
  const resolved = yield* resolveSpawnCommand(spec.command, spec.args, {
    env: spec.env,
    extendEnv: true,
  });
  return { ...spec, ...resolved };
});
