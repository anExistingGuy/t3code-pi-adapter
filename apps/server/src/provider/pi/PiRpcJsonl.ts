import * as Schema from "effect/Schema";

const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export class PiRpcFramingError extends Schema.TaggedErrorClass<PiRpcFramingError>()(
  "PiRpcFramingError",
  {
    reason: Schema.Literals(["record-too-large", "buffer-too-large", "invalid-utf8"]),
    limitBytes: Schema.Number,
    observedBytes: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Pi RPC JSONL framing failed (${this.reason}): observed ${this.observedBytes} bytes with a ${this.limitBytes} byte limit`;
  }
}

export interface PiRpcJsonlDecoderOptions {
  readonly maxRecordBytes?: number;
  readonly maxBufferBytes?: number;
}

export type PiRpcJsonlDecodeResult =
  | { readonly _tag: "Records"; readonly records: ReadonlyArray<string> }
  | { readonly _tag: "Failure"; readonly error: PiRpcFramingError };

/**
 * Stateful strict JSONL decoder. It intentionally recognizes byte 0x0a only;
 * U+2028 and U+2029 remain ordinary JSON string content.
 */
export class PiRpcJsonlDecoder {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #maxRecordBytes: number;
  readonly #maxBufferBytes: number;
  #buffer = "";
  #bufferBytes = 0;
  #failed: PiRpcFramingError | undefined;

  constructor(options: PiRpcJsonlDecoderOptions = {}) {
    this.#maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    this.#maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  }

  push(chunk: Uint8Array): PiRpcJsonlDecodeResult {
    if (this.#failed) return { _tag: "Failure", error: this.#failed };

    const records: string[] = [];
    let offset = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const segment = chunk.subarray(offset, index);
      const failure = this.#append(segment, true);
      if (failure) return failure;
      records.push(this.#takeRecord());
      offset = index + 1;
    }

    const failure = this.#append(chunk.subarray(offset), false);
    return failure ?? { _tag: "Records", records };
  }

  end(): PiRpcJsonlDecodeResult {
    if (this.#failed) return { _tag: "Failure", error: this.#failed };
    try {
      this.#buffer += this.#decoder.decode();
    } catch (cause) {
      return this.#fail("invalid-utf8", this.#maxBufferBytes, this.#bufferBytes, cause);
    }
    if (this.#buffer.length === 0) return { _tag: "Records", records: [] };
    return { _tag: "Records", records: [this.#takeRecord()] };
  }

  #append(segment: Uint8Array, recordEnded: boolean): PiRpcJsonlDecodeResult | undefined {
    this.#bufferBytes += segment.byteLength;
    if (this.#bufferBytes > this.#maxBufferBytes) {
      return this.#fail("buffer-too-large", this.#maxBufferBytes, this.#bufferBytes);
    }
    if (this.#bufferBytes > this.#maxRecordBytes) {
      return this.#fail("record-too-large", this.#maxRecordBytes, this.#bufferBytes);
    }
    try {
      this.#buffer += this.#decoder.decode(segment, { stream: !recordEnded });
      if (recordEnded) {
        this.#buffer += this.#decoder.decode();
      }
    } catch (cause) {
      return this.#fail("invalid-utf8", this.#maxBufferBytes, this.#bufferBytes, cause);
    }
    return undefined;
  }

  #takeRecord(): string {
    const record = this.#buffer.endsWith("\r") ? this.#buffer.slice(0, -1) : this.#buffer;
    this.#buffer = "";
    this.#bufferBytes = 0;
    return record;
  }

  #fail(
    reason: PiRpcFramingError["reason"],
    limitBytes: number,
    observedBytes: number,
    cause?: unknown,
  ): PiRpcJsonlDecodeResult {
    this.#failed = new PiRpcFramingError({
      reason,
      limitBytes,
      observedBytes,
      ...(cause === undefined ? {} : { cause }),
    });
    return { _tag: "Failure", error: this.#failed };
  }
}

export function serializePiRpcJsonl(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}
