import { describe, expect, it } from "vite-plus/test";

import { resolveProviderIconKind } from "./providerIconKind";

describe("resolveProviderIconKind", () => {
  it("routes Pi to its explicit icon branch", () => {
    expect(resolveProviderIconKind("piAgent")).toBe("pi");
  });

  it("keeps unknown providers on the generic fallback", () => {
    expect(resolveProviderIconKind("future-provider")).toBe("generic");
  });
});
