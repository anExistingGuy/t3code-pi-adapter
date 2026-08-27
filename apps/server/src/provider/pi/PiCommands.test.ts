import { describe, expect, it } from "@effect/vitest";

import { mapPiCommands } from "./PiCommands.ts";

describe("Pi command discovery", () => {
  it("maps extension commands, prompt templates, and scoped skills in returned order", () => {
    const mapped = mapPiCommands([
      {
        name: "deploy",
        description: "Deploy from extension",
        source: "extension",
        sourceInfo: {
          path: "/extensions/deploy.ts",
          source: "settings",
          scope: "user",
          origin: "top-level",
        },
      },
      {
        name: "review",
        description: "Review the change",
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
        description: "Work with PDFs",
        source: "skill",
        sourceInfo: {
          path: "/home/user/.pi/agent/skills/pdf/SKILL.md",
          source: "user skills",
          scope: "user",
          origin: "top-level",
        },
      },
      {
        name: "skill:temporary",
        source: "skill",
        sourceInfo: {
          path: "/tmp/SKILL.md",
          source: "cli",
          scope: "temporary",
          origin: "top-level",
        },
      },
    ]);

    expect(mapped.slashCommands.map((command) => command.name)).toEqual([
      "deploy",
      "review",
      "skill:pdf-tools",
      "skill:temporary",
    ]);
    expect(mapped.skills).toEqual([
      {
        name: "pdf-tools",
        path: "/home/user/.pi/agent/skills/pdf/SKILL.md",
        scope: "user",
        enabled: true,
        displayName: "Pdf Tools",
        description: "Work with PDFs",
        shortDescription: "Work with PDFs",
      },
      {
        name: "temporary",
        path: "/tmp/SKILL.md",
        scope: "temporary",
        enabled: true,
        displayName: "Temporary",
      },
    ]);
  });

  it("keeps unknown future command sources as generic slash commands", () => {
    expect(
      mapPiCommands([
        { name: "future-command", description: "From a future Pi source", source: "package" },
      ]),
    ).toEqual({
      slashCommands: [{ name: "future-command", description: "From a future Pi source" }],
      skills: [],
    });
  });

  it("keeps the first exact invocation name and omits skills without source paths", () => {
    const mapped = mapPiCommands([
      { name: "same", description: "first", source: "prompt" },
      { name: "same", description: "second", source: "extension" },
      { name: "skill:pathless", source: "skill" },
    ]);

    expect(mapped.slashCommands).toEqual([
      { name: "same", description: "first" },
      { name: "skill:pathless" },
    ]);
    expect(mapped.skills).toEqual([]);
  });
});
