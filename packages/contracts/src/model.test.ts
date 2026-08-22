import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  PI_DRIVER_KIND,
  PROVIDER_DISPLAY_NAMES,
} from "./model.ts";

describe("Pi model metadata", () => {
  it("provides a display name without inventing static model policy", () => {
    expect(PROVIDER_DISPLAY_NAMES[PI_DRIVER_KIND]).toBe("Pi");
    expect(DEFAULT_MODEL_BY_PROVIDER[PI_DRIVER_KIND]).toBeUndefined();
    expect(DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[PI_DRIVER_KIND]).toBeUndefined();
    expect(MODEL_SLUG_ALIASES_BY_PROVIDER[PI_DRIVER_KIND]).toBeUndefined();
  });
});
