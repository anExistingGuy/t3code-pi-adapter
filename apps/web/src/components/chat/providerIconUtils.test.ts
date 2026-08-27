import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { PiAgentIcon } from "../Icons";
import { AVAILABLE_PROVIDER_OPTIONS, PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";

describe("Pi provider client metadata", () => {
  it("is available in the model picker with the Pi icon", () => {
    expect(
      AVAILABLE_PROVIDER_OPTIONS.find(
        (option) => option.value === ProviderDriverKind.make("piAgent"),
      ),
    ).toMatchObject({ label: "Pi", available: true });
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("piAgent")]).toBe(PiAgentIcon);
  });

  it("leaves unknown provider icons unresolved", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("futureDriver")]).toBeUndefined();
  });
});
