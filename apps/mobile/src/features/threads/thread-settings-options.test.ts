import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectableChoices } from "./thread-settings-options";

const effortDescriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
    { id: "ultrathink", label: "Ultrathink" },
    { id: "ultracode", label: "Ultracode" },
  ],
  currentValue: "high",
  promptInjectedValues: ["ultrathink"],
};

describe("selectableChoices", () => {
  it("preserves every Pi thinking level including off and max", () => {
    const thinkingLevel = {
      id: "thinkingLevel",
      label: "Thinking level",
      type: "select" as const,
      options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((id) => ({
        id,
        label: id === "xhigh" ? "Extra high" : id.charAt(0).toUpperCase() + id.slice(1),
      })),
    };

    expect(selectableChoices(thinkingLevel).map((choice) => choice.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
  it("hides prompt-injected and workflow-trigger choices, keeping declared order", () => {
    expect(selectableChoices(effortDescriptor).map((choice) => choice.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });
});
