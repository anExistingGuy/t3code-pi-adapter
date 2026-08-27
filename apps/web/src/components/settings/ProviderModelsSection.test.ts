import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  providerUsesExternalModelCatalog,
  startsModelSubProviderGroup,
} from "./ProviderModelsSection";

describe("ProviderModelsSection", () => {
  it("keeps Pi model configuration in Pi while retaining the catalog controls", () => {
    expect(providerUsesExternalModelCatalog(ProviderDriverKind.make("piAgent"))).toBe(true);
    expect(providerUsesExternalModelCatalog(ProviderDriverKind.make("codex"))).toBe(false);
    expect(providerUsesExternalModelCatalog(null)).toBe(false);
  });

  it("starts friendly groups when the discovered Pi provider changes", () => {
    expect(startsModelSubProviderGroup({ subProvider: "OpenAI" }, undefined)).toBe(true);
    expect(startsModelSubProviderGroup({ subProvider: "OpenAI" }, { subProvider: "OpenAI" })).toBe(
      false,
    );
    expect(
      startsModelSubProviderGroup({ subProvider: "Anthropic" }, { subProvider: "OpenAI" }),
    ).toBe(true);
  });
});
