import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import {
  decodePiModelSlug,
  encodePiModelSlug,
  getPiSupportedThinkingLevels,
  mapPiModels,
} from "./PiModelCatalog.ts";
import type { PiModel } from "./PiRpcProtocol.ts";

function model(overrides: Partial<PiModel> = {}): PiModel {
  return {
    id: "claude/sonnet%encoded",
    name: "Claude Sonnet",
    api: "custom",
    provider: "custom provider!",
    baseUrl: "http://localhost.invalid",
    reasoning: true,
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 32_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

describe("Pi model slug codec", () => {
  it("round trips provider and model components losslessly", () => {
    const values = [
      "anthropic",
      "claude/sonnet",
      "provider with punctuation !@#",
      "%2F already-looking",
      "模型/🥧",
    ];
    for (const provider of values) {
      for (const modelId of values) {
        const encoded = encodePiModelSlug({ provider, modelId });
        expect(encoded.split("/")).toHaveLength(2);
        const decoded = decodePiModelSlug(encoded);
        expect(Result.isSuccess(decoded)).toBe(true);
        if (Result.isSuccess(decoded)) expect(decoded.success).toEqual({ provider, modelId });
      }
    }
  });

  it("rejects empty components, extra separators, and malformed escapes", () => {
    for (const slug of ["", "/model", "provider/", "a/b/c", "%/model", "model/%E0%A4%A"]) {
      expect(Result.isFailure(decodePiModelSlug(slug)), slug).toBe(true);
    }
  });
});

describe("Pi model catalog mapping", () => {
  it("mirrors Pi thinking-level compatibility including holes and opt-in extended levels", () => {
    expect(getPiSupportedThinkingLevels(model({ reasoning: false }))).toEqual(["off"]);
    expect(
      getPiSupportedThinkingLevels(
        model({
          thinkingLevelMap: { minimal: null, xhigh: null, max: "maximum" },
        }),
      ),
    ).toEqual(["off", "low", "medium", "high", "max"]);
  });

  it("preserves provider identity, order, active thinking, and exact-pair deduplication", () => {
    const active = model({ provider: "provider/a", id: "same/id", name: "" });
    const otherProvider = model({ provider: "provider b", id: "same/id", name: "Other" });
    const nonReasoning = model({ provider: "plain", id: "plain", reasoning: false });
    const mapped = mapPiModels({
      models: [active, otherProvider, active, nonReasoning],
      currentModel: active,
      currentThinkingLevel: "xhigh",
      activeThinkingLevels: ["off", "high", "xhigh", "max"],
    });

    expect(mapped).toHaveLength(3);
    expect(mapped.map((entry) => entry.subProvider)).toEqual(["provider/a", "provider b", "plain"]);
    expect(mapped[0]?.name).toBe("same/id");
    expect(mapped[0]?.isDefault).toBe(true);
    expect(mapped[0]?.slug).not.toBe(mapped[1]?.slug);
    expect(mapped[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "thinkingLevel",
      currentValue: "xhigh",
      options: [
        { id: "off", label: "off" },
        { id: "high", label: "high" },
        { id: "xhigh", label: "xhigh" },
        { id: "max", label: "max" },
      ],
    });
    expect(mapped[1]?.capabilities?.optionDescriptors?.[0]).not.toHaveProperty("currentValue");
    expect(mapped[2]?.capabilities?.optionDescriptors).toEqual([]);
  });

  it("keeps large catalog ordering deterministic while removing only exact pairs", () => {
    const catalog = Array.from({ length: 200 }, (_, index) =>
      model({ provider: `provider-${index % 7}`, id: `model/${index}`, name: `Model ${index}` }),
    );
    const mapped = mapPiModels({ models: [...catalog, ...catalog] });

    expect(mapped).toHaveLength(200);
    expect(mapped.map((entry) => entry.name)).toEqual(catalog.map((entry) => entry.name));
  });
});
