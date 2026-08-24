import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";

import type { PiSlashCommand } from "./PiRpcProtocol.ts";

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function displayNameForSkill(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function mapPiCommands(commands: ReadonlyArray<PiSlashCommand>): {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
} {
  const seen = new Set<string>();
  const slashCommands: ServerProviderSlashCommand[] = [];
  const skills: ServerProviderSkill[] = [];

  for (const command of commands) {
    if (!nonEmpty(command.name) || seen.has(command.name)) continue;
    seen.add(command.name);

    const description = nonEmpty(command.description);
    slashCommands.push({
      name: command.name,
      ...(description ? { description } : {}),
    });

    if (command.source !== "skill") continue;
    const path = nonEmpty(command.sourceInfo?.path ?? command.path);
    if (!path) continue;
    const name = command.name.startsWith("skill:")
      ? command.name.slice("skill:".length)
      : command.name;
    if (!nonEmpty(name)) continue;
    const scope = nonEmpty(command.sourceInfo?.scope ?? command.location);
    skills.push({
      name,
      path,
      enabled: true,
      displayName: displayNameForSkill(name) || name,
      ...(scope ? { scope } : {}),
      ...(description ? { description, shortDescription: description } : {}),
    });
  }

  return { slashCommands, skills };
}
