import { describe, expect, it } from "vite-plus/test";

import type { PiAssistantMessage, PiRpcKnownEvent, PiUsage } from "./PiRpcProtocol.ts";
import {
  makePiRuntimeTranslationState,
  piSessionStatsUsageSnapshot,
  translatePiRpcEvent,
} from "./PiRuntimeEvents.ts";

const usage = (overrides: Partial<PiUsage> = {}): PiUsage => ({
  input: 100,
  output: 20,
  cacheRead: 10,
  cacheWrite: 0,
  reasoning: 5,
  totalTokens: 130,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
  ...overrides,
});

const assistant = (
  stopReason: string,
  content: PiAssistantMessage["content"] = [{ type: "text", text: "Hello world" }],
): PiAssistantMessage => ({
  role: "assistant",
  content,
  api: "test",
  provider: "custom",
  model: "model/id",
  usage: usage(),
  stopReason,
  timestamp: 1,
  ...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
});

const translate = (
  state: ReturnType<typeof makePiRuntimeTranslationState>,
  event: PiRpcKnownEvent,
) => translatePiRpcEvent(state, event, { generation: 1, contextWindow: 1_000 });

describe("PiRuntimeEvents", () => {
  it("assembles multiple text and thinking blocks and reconciles the final snapshot", () => {
    const state = makePiRuntimeTranslationState();
    const records: PiRpcKnownEvent[] = [
      { type: "message_start", message: assistant("stop", []) },
      {
        type: "message_update",
        usage: usage({ totalTokens: 0, input: 0, output: 0, cacheRead: 0 }),
        assistantMessageEvent: { type: "text_start", contentIndex: 0 },
      },
      {
        type: "message_update",
        usage: usage(),
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" },
      },
      {
        type: "message_update",
        usage: usage(),
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello world" },
      },
      {
        type: "message_update",
        usage: usage(),
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "Think" },
      },
      {
        type: "message_update",
        usage: usage(),
        assistantMessageEvent: {
          type: "thinking_end",
          contentIndex: 1,
          content: "Think carefully",
        },
      },
      {
        type: "message_end",
        message: assistant("stop", [
          { type: "text", text: "Hello world" },
          { type: "thinking", thinking: "Think carefully" },
          { type: "text", text: "Second block" },
        ]),
      },
    ];

    const events = records.flatMap((record) => translate(state, record).events);
    const deltas = events.filter((event) => event.type === "content.delta");
    expect(
      deltas.map((event) =>
        event.type === "content.delta"
          ? [event.payload.streamKind, event.payload.contentIndex, event.payload.delta]
          : [],
      ),
    ).toEqual([
      ["assistant_text", 0, "Hello"],
      ["assistant_text", 0, " world"],
      ["reasoning_text", 1, "Think"],
      ["reasoning_text", 1, " carefully"],
      ["assistant_text", 2, "Second block"],
    ]);
    expect(events.filter((event) => event.type === "item.completed")).toHaveLength(3);
    expect(events.filter((event) => event.type === "thread.token-usage.updated")).toHaveLength(1);
  });

  it("preserves arbitrary tools, replaces accumulated output, and strips image data", () => {
    const state = makePiRuntimeTranslationState();
    translate(state, {
      type: "message_update",
      usage: usage(),
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: {
          type: "toolCall",
          id: "custom-call",
          name: "extension_magic",
          arguments: { target: "thing" },
        },
      },
    });
    const started = translate(state, {
      type: "tool_execution_start",
      toolCallId: "custom-call",
      toolName: "extension_magic",
      args: { target: "thing" },
    });
    const first = translate(state, {
      type: "tool_execution_update",
      toolCallId: "custom-call",
      toolName: "extension_magic",
      args: { target: "thing" },
      partialResult: { content: [{ type: "text", text: "one" }] },
    });
    const second = translate(state, {
      type: "tool_execution_update",
      toolCallId: "custom-call",
      toolName: "extension_magic",
      args: { target: "thing" },
      partialResult: { content: [{ type: "text", text: "one two" }] },
    });
    const ended = translate(state, {
      type: "tool_execution_end",
      toolCallId: "custom-call",
      toolName: "extension_magic",
      result: {
        content: [
          { type: "text", text: "done" },
          { type: "image", data: "secret-base64", mimeType: "image/png" },
        ],
        details: { future: true },
      },
      isError: true,
    });

    expect(started.events[0]).toMatchObject({
      type: "item.started",
      itemId: "custom-call",
      payload: { itemType: "dynamic_tool_call" },
    });
    expect(first.events[0]).toMatchObject({
      payload: { data: { rawOutput: { content: "one" } } },
    });
    expect(second.events[0]).toMatchObject({
      payload: { data: { rawOutput: { content: "one two" } } },
    });
    expect(ended.events[0]).toMatchObject({
      type: "item.completed",
      payload: { status: "failed" },
    });
    expect(JSON.stringify(ended.events)).not.toContain("secret-base64");
    expect(JSON.stringify(ended.events)).toContain("encodedBytes");
  });

  it.each([
    ["stop", "completed", undefined],
    ["toolUse", "completed", undefined],
    ["length", "completed", "Pi reached the model output limit."],
    ["aborted", "interrupted", undefined],
    ["error", "failed", undefined],
  ] as const)("settles stop reason %s as %s", (reason, expectedState, warning) => {
    const state = makePiRuntimeTranslationState();
    translate(state, {
      type: "agent_end",
      messages: [assistant(reason)],
      willRetry: reason === "error",
    });
    const beforeSettlement = translate(state, {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 10,
      errorMessage: "temporary",
    });
    expect(beforeSettlement.settlement).toBeUndefined();
    const settled = translate(state, { type: "agent_settled" });
    expect(settled.settlement?.state).toBe(expectedState);
    expect(settled.settlement?.warning).toBe(warning);
  });

  it("maps retry success, retry failure, and extension errors without settling", () => {
    const state = makePiRuntimeTranslationState();
    const start = translate(state, {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 2,
      delayMs: 50,
      errorMessage: "overloaded",
    });
    const failed = translate(state, {
      type: "auto_retry_end",
      success: false,
      attempt: 2,
      finalError: "still overloaded",
    });
    const extension = translate(state, {
      type: "extension_error",
      extensionPath: "/tmp/example.ts",
      event: "tool_call",
      error: "extension failed",
    });

    expect(start.events[0]).toMatchObject({ type: "task.progress" });
    expect(failed.events[0]).toMatchObject({
      type: "task.completed",
      payload: { status: "failed", summary: "still overloaded" },
    });
    expect(extension.events[0]).toMatchObject({
      type: "runtime.warning",
      payload: { message: "extension failed" },
    });
    expect(start.settlement).toBeUndefined();
    expect(failed.settlement).toBeUndefined();
  });

  it("keeps compaction and retry events non-terminal", () => {
    const state = makePiRuntimeTranslationState();
    const start = translate(state, { type: "compaction_start", reason: "overflow" });
    const end = translate(state, {
      type: "compaction_end",
      reason: "overflow",
      result: {
        summary: "summary",
        firstKeptEntryId: "entry",
        tokensBefore: 900,
        estimatedTokensAfter: 200,
      },
      aborted: false,
      willRetry: true,
    });
    expect(start.events[0]?.type).toBe("task.started");
    expect(end.events.map((event) => event.type)).toEqual([
      "task.completed",
      "thread.state.changed",
    ]);
    expect(end.settlement).toBeUndefined();
    expect(end.reconcileStats).toBe(true);
  });

  it("shows displayed custom messages and ignores hidden custom messages", () => {
    const state = makePiRuntimeTranslationState();
    const visible = translate(state, {
      type: "message_end",
      message: {
        role: "custom",
        customType: "notice",
        content: "Extension notice",
        display: true,
        details: { status: "ok" },
        timestamp: 1,
      },
    });
    const hidden = translate(state, {
      type: "message_end",
      message: {
        role: "custom",
        customType: "private",
        content: "Hidden context",
        display: false,
        timestamp: 2,
      },
    });
    expect(visible.events[0]).toMatchObject({
      type: "runtime.warning",
      payload: { message: "Extension notice", detail: { customType: "notice" } },
    });
    expect(hidden.events).toEqual([]);
  });

  it("maps cumulative session stats without adding nested usage twice", () => {
    expect(
      piSessionStatsUsageSnapshot({
        sessionId: "session",
        userMessages: 2,
        assistantMessages: 2,
        toolCalls: 3,
        toolResults: 3,
        totalMessages: 10,
        tokens: { input: 500, output: 100, cacheRead: 250, cacheWrite: 0, total: 850 },
        cost: 1,
        contextUsage: { tokens: 400, contextWindow: 1_000, percent: 40 },
      }),
    ).toEqual({
      usedTokens: 400,
      totalProcessedTokens: 850,
      maxTokens: 1_000,
      inputTokens: 500,
      cachedInputTokens: 250,
      outputTokens: 100,
      lastUsedTokens: 400,
      toolUses: 3,
      compactsAutomatically: true,
    });
  });
});
