import { describe, expect, it } from "vite-plus/test";

import { PiRpcJsonlDecoder, serializePiRpcJsonl } from "./PiRpcJsonl.ts";

const encoder = new TextEncoder();

function collect(decoder: PiRpcJsonlDecoder, chunks: ReadonlyArray<Uint8Array>) {
  const records: string[] = [];
  for (const chunk of chunks) {
    const result = decoder.push(chunk);
    if (result._tag === "Failure") return result;
    records.push(...result.records);
  }
  const ended = decoder.end();
  if (ended._tag === "Failure") return ended;
  records.push(...ended.records);
  return { _tag: "Records" as const, records };
}

describe("PiRpcJsonlDecoder", () => {
  it("decodes arbitrary chunks, multiple records, CRLF, and a final unterminated record", () => {
    const bytes = encoder.encode('{"a":1}\r\n{"b":2}\n{"c":3}');
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));

    expect(collect(new PiRpcJsonlDecoder(), chunks)).toEqual({
      _tag: "Records",
      records: ['{"a":1}', '{"b":2}', '{"c":3}'],
    });
  });

  it("preserves Unicode line and paragraph separators inside one JSON record", () => {
    const line = JSON.stringify({ text: `before\u2028middle\u2029after` });
    const result = collect(new PiRpcJsonlDecoder(), [encoder.encode(`${line}\n`)]);

    expect(result).toEqual({ _tag: "Records", records: [line] });
  });

  it("decodes UTF-8 code points split across chunks", () => {
    const bytes = serializePiRpcJsonl({ text: "A 🥧 café" });
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
    const result = collect(new PiRpcJsonlDecoder(), chunks);

    expect(result._tag).toBe("Records");
    if (result._tag === "Records") {
      expect(JSON.parse(result.records[0]!)).toEqual({ text: "A 🥧 café" });
    }
  });

  it("fails bounded unterminated buffers and oversized records", () => {
    const bufferFailure = new PiRpcJsonlDecoder({ maxBufferBytes: 4, maxRecordBytes: 10 }).push(
      encoder.encode("12345"),
    );
    expect(bufferFailure._tag).toBe("Failure");
    if (bufferFailure._tag === "Failure") {
      expect(bufferFailure.error.reason).toBe("buffer-too-large");
    }

    const recordFailure = new PiRpcJsonlDecoder({ maxBufferBytes: 10, maxRecordBytes: 4 }).push(
      encoder.encode("12345\n"),
    );
    expect(recordFailure._tag).toBe("Failure");
    if (recordFailure._tag === "Failure") {
      expect(recordFailure.error.reason).toBe("record-too-large");
    }
  });

  it("reports malformed UTF-8", () => {
    const decoder = new PiRpcJsonlDecoder();
    const result = decoder.push(Uint8Array.of(0xc3, 0x28, 0x0a));

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.error.reason).toBe("invalid-utf8");
    }
  });
});
