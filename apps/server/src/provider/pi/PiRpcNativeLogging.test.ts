import { describe, expect, it } from "vite-plus/test";

import { formatPiRpcProtocolLog } from "./PiRpcNativeLogging.ts";

describe("Pi RPC native logging", () => {
  it("removes image payloads and bounds large provider output", () => {
    const secretImage = "base64-secret".repeat(1_000);
    const output = "x".repeat(10_000);
    const formatted = formatPiRpcProtocolLog({
      direction: "incoming",
      payload: {
        type: "tool_execution_end",
        result: {
          content: [
            { type: "image", data: secretImage, mimeType: "image/png" },
            { type: "text", text: output },
          ],
        },
      },
    });
    const serialized = JSON.stringify(formatted);

    expect(serialized).not.toContain(secretImage);
    expect(serialized.length).toBeLessThan(6_000);
    expect(serialized).toContain("truncated");
  });
});
