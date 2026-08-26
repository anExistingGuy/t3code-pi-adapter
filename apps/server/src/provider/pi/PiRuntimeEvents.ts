import {
  ProviderItemId,
  RuntimeItemId,
  RuntimeTaskId,
  type ProviderRuntimeEvent,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { PiAssistantMessage } from "./PiRpcProtocol.ts";
import type {
  PiAgentMessage,
  PiRpcKnownEvent,
  PiSessionStats,
  PiToolCallContent,
  PiUsage,
} from "./PiRpcProtocol.ts";

const MAX_DETAIL_CHARS = 4_096;
const MAX_TOOL_OUTPUT_CHARS = 24_000;
const MAX_UNKNOWN_FIELDS = 48;
const MAX_UNKNOWN_ARRAY_ITEMS = 32;
const isPiAssistantMessage = Schema.is(PiAssistantMessage);

type RuntimeEventDraft<Event> = Event extends ProviderRuntimeEvent
  ? Omit<
      Event,
      "eventId" | "provider" | "providerInstanceId" | "threadId" | "createdAt" | "turnId" | "raw"
    >
  : never;

export type PiRuntimeEventDraft = RuntimeEventDraft<ProviderRuntimeEvent>;

interface ContentBlockState {
  readonly itemId: RuntimeItemId;
  readonly kind: "text" | "thinking";
  readonly contentIndex: number;
  text: string;
  started: boolean;
  completed: boolean;
}

interface ToolMetadata {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly namespace?: string | undefined;
}

export interface PiRuntimeTranslationState {
  generation: number;
  messageSequence: number;
  messageOpen: boolean;
  readonly blocks: Map<string, ContentBlockState>;
  readonly toolMetadata: Map<string, ToolMetadata>;
  readonly activeTools: Map<string, ToolMetadata>;
  readonly completedTools: Set<string>;
  readonly processedAssistantTimestamps: Set<number>;
  readonly directBashOutput: Map<string, string>;
  terminal: PiTerminalOutcome;
  compactionSequence: number;
  retrySequence: number;
  summarizationSequence: number;
  activeCompactionTaskId: RuntimeTaskId | undefined;
  activeRetryTaskId: RuntimeTaskId | undefined;
  activeSummarizationTaskId: RuntimeTaskId | undefined;
  lastUsageFingerprint: string | undefined;
}

export interface PiTerminalOutcome {
  readonly state: "completed" | "failed" | "interrupted";
  readonly stopReason: string | null;
  readonly errorMessage?: string | undefined;
  readonly warning?: string | undefined;
  readonly usage?: PiUsage | undefined;
}

export interface PiTranslationContext {
  readonly generation: number;
  readonly contextWindow?: number | undefined;
}

export interface PiTranslationResult {
  readonly events: ReadonlyArray<PiRuntimeEventDraft>;
  readonly settlement?: PiTerminalOutcome | undefined;
  readonly reconcileStats?: boolean | undefined;
}

export function makePiRuntimeTranslationState(): PiRuntimeTranslationState {
  return {
    generation: 0,
    messageSequence: 0,
    messageOpen: false,
    blocks: new Map(),
    toolMetadata: new Map(),
    activeTools: new Map(),
    completedTools: new Set(),
    processedAssistantTimestamps: new Set(),
    directBashOutput: new Map(),
    terminal: { state: "completed", stopReason: null },
    compactionSequence: 0,
    retrySequence: 0,
    summarizationSequence: 0,
    activeCompactionTaskId: undefined,
    activeRetryTaskId: undefined,
    activeSummarizationTaskId: undefined,
    lastUsageFingerprint: undefined,
  };
}

function boundedText(value: string, limit = MAX_DETAIL_CHARS): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

export function boundPiRuntimeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "<depth-limit>";
  if (Predicate.isString(value)) return boundedText(value);
  if (
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value) ||
    Predicate.isNull(value) ||
    Predicate.isUndefined(value)
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_UNKNOWN_ARRAY_ITEMS)
      .map((entry) => boundPiRuntimeValue(entry, depth + 1));
  }
  if (!Predicate.isObject(value)) return { valueType: typeof value };

  const output: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value).slice(0, MAX_UNKNOWN_FIELDS)) {
    if (key === "data" && Predicate.isString(fieldValue)) {
      output[key] = `<omitted ${fieldValue.length} chars>`;
      continue;
    }
    output[key] = boundPiRuntimeValue(fieldValue, depth + 1);
  }
  return output;
}

function finiteCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function usageSnapshot(
  usage: PiUsage,
  contextWindow: number | undefined,
): ThreadTokenUsageSnapshot | undefined {
  const used = finiteCount(usage.totalTokens);
  if (used <= 0) return undefined;
  const maxTokens =
    contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0
      ? Math.floor(contextWindow)
      : undefined;
  const usedTokens = maxTokens === undefined ? used : Math.min(used, maxTokens);
  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    inputTokens: finiteCount(usage.input),
    cachedInputTokens: finiteCount(usage.cacheRead),
    outputTokens: finiteCount(usage.output),
    reasoningOutputTokens: finiteCount(usage.reasoning ?? 0),
    lastInputTokens: finiteCount(usage.input),
    lastCachedInputTokens: finiteCount(usage.cacheRead),
    lastOutputTokens: finiteCount(usage.output),
    lastReasoningOutputTokens: finiteCount(usage.reasoning ?? 0),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    compactsAutomatically: true,
  };
}

export function piSessionStatsUsageSnapshot(
  stats: PiSessionStats,
): ThreadTokenUsageSnapshot | undefined {
  const contextTokens = stats.contextUsage?.tokens;
  if (contextTokens === null || contextTokens === undefined) return undefined;
  const maxTokens = finiteCount(stats.contextUsage?.contextWindow ?? 0);
  const usedTokens =
    maxTokens > 0 ? Math.min(finiteCount(contextTokens), maxTokens) : finiteCount(contextTokens);
  if (usedTokens <= 0) return undefined;
  return {
    usedTokens,
    totalProcessedTokens: finiteCount(stats.tokens.total),
    maxTokens: Math.max(1, maxTokens),
    inputTokens: finiteCount(stats.tokens.input),
    cachedInputTokens: finiteCount(stats.tokens.cacheRead),
    outputTokens: finiteCount(stats.tokens.output),
    lastUsedTokens: usedTokens,
    toolUses: finiteCount(stats.toolCalls),
    compactsAutomatically: true,
  };
}

function normalizeToolName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[._:/-]+/gu, " ")
    .replace(/\s+/gu, " ");
}

function toolItemType(
  metadata: ToolMetadata,
): Extract<ProviderRuntimeEvent, { type: "item.started" }>["payload"]["itemType"] {
  const name = normalizeToolName(metadata.name);
  const namespace = metadata.namespace ? normalizeToolName(metadata.namespace) : undefined;
  if (namespace?.includes("mcp") || name.startsWith("mcp ") || name.includes(" mcp ")) {
    return "mcp_tool_call";
  }
  if (/^(bash|shell|exec|execute|command|powershell)( |$)/u.test(name)) {
    return "command_execution";
  }
  if (/^(write|edit|patch|apply patch|delete|move|rename)( |$)/u.test(name)) {
    return "file_change";
  }
  if (/^(web|search web|fetch|browser)( |$)/u.test(name)) {
    return "web_search";
  }
  if (/^(image|view image|open image)( |$)/u.test(name)) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

function stringField(record: Readonly<Record<string, unknown>>, keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const value = record[key];
    if (Predicate.isString(value) && value.trim().length > 0) return value;
  }
  return undefined;
}

function toolDetail(metadata: ToolMetadata): string | undefined {
  const candidate = stringField(metadata.args, [
    "command",
    "path",
    "filePath",
    "query",
    "url",
    "pattern",
    "description",
  ]);
  return candidate ? boundedText(candidate, 512) : undefined;
}

function sanitizeToolResult(value: unknown): unknown {
  if (!Predicate.isObject(value)) return boundPiRuntimeValue(value);
  const result: Record<string, unknown> = {};
  const content = Reflect.get(value, "content");
  if (Array.isArray(content)) {
    let remaining = MAX_TOOL_OUTPUT_CHARS;
    result.content = content.slice(0, MAX_UNKNOWN_ARRAY_ITEMS).map((entry) => {
      if (!Predicate.isObject(entry)) return boundPiRuntimeValue(entry);
      const type = Reflect.get(entry, "type");
      if (type === "image") {
        const data = Reflect.get(entry, "data");
        return {
          type: "image",
          ...(Predicate.isString(Reflect.get(entry, "mimeType"))
            ? { mimeType: Reflect.get(entry, "mimeType") }
            : {}),
          ...(Predicate.isString(data) ? { encodedBytes: data.length } : {}),
        };
      }
      const text = Reflect.get(entry, "text");
      if (Predicate.isString(text)) {
        const bounded = boundedText(text, remaining);
        remaining = Math.max(0, remaining - bounded.length);
        return { type: Predicate.isString(type) ? type : "text", text: bounded };
      }
      return boundPiRuntimeValue(entry);
    });
  }
  const details = Reflect.get(value, "details");
  if (details !== undefined) result.details = boundPiRuntimeValue(details);
  if (Object.keys(result).length === 0) return boundPiRuntimeValue(value);
  return result;
}

function toolOutputPreview(value: unknown): Record<string, unknown> {
  if (Predicate.isString(value)) {
    return { content: boundedText(value, MAX_TOOL_OUTPUT_CHARS) };
  }
  if (!Predicate.isObject(value)) return {};
  const content = Reflect.get(value, "content");
  if (!Array.isArray(content)) return {};
  const texts = content
    .map((entry) =>
      Predicate.isObject(entry) &&
      Reflect.get(entry, "type") === "text" &&
      Predicate.isString(Reflect.get(entry, "text"))
        ? Reflect.get(entry, "text")
        : undefined,
    )
    .filter(Predicate.isString)
    .join("\n");
  return texts.length > 0 ? { content: boundedText(texts, MAX_TOOL_OUTPUT_CHARS) } : {};
}

function titleForTool(metadata: ToolMetadata): string {
  const itemType = toolItemType(metadata);
  switch (itemType) {
    case "command_execution":
      return "Command";
    case "file_change":
      return "File change";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "mcp_tool_call":
      return metadata.namespace ? `${metadata.namespace} · ${metadata.name}` : metadata.name;
    default:
      return metadata.name;
  }
}

function blockKey(state: PiRuntimeTranslationState, kind: "text" | "thinking", index: number) {
  return `${state.generation}:${state.messageSequence}:${kind}:${index}`;
}

function resetGeneration(state: PiRuntimeTranslationState, generation: number): void {
  if (state.generation === generation) return;
  state.generation = generation;
  state.messageSequence = 0;
  state.messageOpen = false;
  state.blocks.clear();
  state.toolMetadata.clear();
  state.activeTools.clear();
  state.completedTools.clear();
  state.processedAssistantTimestamps.clear();
  state.directBashOutput.clear();
  state.terminal = { state: "completed", stopReason: null };
}

function ensureMessage(state: PiRuntimeTranslationState, generation: number): void {
  resetGeneration(state, generation);
  if (!state.messageOpen) {
    state.messageSequence += 1;
    state.messageOpen = true;
  }
}

function ensureBlock(
  state: PiRuntimeTranslationState,
  generation: number,
  kind: "text" | "thinking",
  contentIndex: number,
): ContentBlockState {
  ensureMessage(state, generation);
  const key = blockKey(state, kind, contentIndex);
  const existing = state.blocks.get(key);
  if (existing) return existing;
  const itemId = RuntimeItemId.make(
    `pi:${generation}:${state.messageSequence}:${kind}:${contentIndex}`,
  );
  const block = { itemId, kind, contentIndex, text: "", started: false, completed: false };
  state.blocks.set(key, block);
  return block;
}

function asProviderItemId(value: RuntimeItemId): ProviderItemId {
  return ProviderItemId.make(String(value));
}

function startBlock(block: ContentBlockState): PiRuntimeEventDraft | undefined {
  if (block.started) return undefined;
  block.started = true;
  return {
    type: "item.started",
    itemId: block.itemId,
    providerRefs: { providerItemId: asProviderItemId(block.itemId) },
    payload: {
      itemType: block.kind === "text" ? "assistant_message" : "reasoning",
      status: "inProgress",
      title: block.kind === "text" ? "Assistant message" : "Reasoning",
    },
  };
}

function appendAuthoritativeBlock(
  block: ContentBlockState,
  authoritative: string,
  events: PiRuntimeEventDraft[],
): void {
  const started = startBlock(block);
  if (started) events.push(started);
  if (authoritative.startsWith(block.text)) {
    const suffix = authoritative.slice(block.text.length);
    if (suffix.length > 0) {
      events.push({
        type: "content.delta",
        itemId: block.itemId,
        providerRefs: { providerItemId: asProviderItemId(block.itemId) },
        payload: {
          streamKind: block.kind === "text" ? "assistant_text" : "reasoning_text",
          delta: suffix,
          contentIndex: block.contentIndex,
        },
      });
    }
  } else if (block.text.length > 0) {
    events.push({
      type: "runtime.warning",
      itemId: block.itemId,
      payload: {
        message: `Pi ${block.kind} stream differed from its final message snapshot.`,
        detail: { contentIndex: block.contentIndex },
      },
    });
  }
  block.text = authoritative;
  if (!block.completed) {
    block.completed = true;
    events.push({
      type: "item.completed",
      itemId: block.itemId,
      providerRefs: { providerItemId: asProviderItemId(block.itemId) },
      payload: {
        itemType: block.kind === "text" ? "assistant_message" : "reasoning",
        status: "completed",
        title: block.kind === "text" ? "Assistant message" : "Reasoning",
        ...(authoritative.length > 0 ? { detail: boundedText(authoritative) } : {}),
      },
    });
  }
}

function assistantOutcome(message: PiAssistantMessage): PiTerminalOutcome {
  const errorMessage = message.errorMessage ? boundedText(message.errorMessage) : undefined;
  switch (message.stopReason) {
    case "aborted":
      return { state: "interrupted", stopReason: "aborted", usage: message.usage };
    case "error":
      return {
        state: "failed",
        stopReason: "error",
        errorMessage: errorMessage ?? "Pi assistant response failed.",
        usage: message.usage,
      };
    case "length":
      return {
        state: "completed",
        stopReason: "length",
        warning: "Pi reached the model output limit.",
        usage: message.usage,
      };
    default:
      return { state: "completed", stopReason: message.stopReason, usage: message.usage };
  }
}

function reconcileAssistantMessage(
  state: PiRuntimeTranslationState,
  generation: number,
  message: PiAssistantMessage,
  events: PiRuntimeEventDraft[],
): void {
  if (state.processedAssistantTimestamps.has(message.timestamp)) {
    state.terminal = assistantOutcome(message);
    state.messageOpen = false;
    return;
  }
  state.processedAssistantTimestamps.add(message.timestamp);
  ensureMessage(state, generation);
  for (const [contentIndex, content] of message.content.entries()) {
    if (content.type === "text") {
      appendAuthoritativeBlock(
        ensureBlock(state, generation, "text", contentIndex),
        content.text,
        events,
      );
    } else if (content.type === "thinking" && content.redacted !== true) {
      appendAuthoritativeBlock(
        ensureBlock(state, generation, "thinking", contentIndex),
        content.thinking,
        events,
      );
    } else if (content.type === "toolCall") {
      state.toolMetadata.set(content.id, {
        name: content.name,
        args: content.arguments,
        ...(content.namespace ? { namespace: content.namespace } : {}),
      });
    }
  }
  state.terminal = assistantOutcome(message);
  state.messageOpen = false;
}

function messageText(message: PiAgentMessage): string | undefined {
  if (!("content" in message)) return undefined;
  if (Predicate.isString(message.content)) return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content
    .map((entry) =>
      Predicate.isObject(entry) && Reflect.get(entry, "type") === "text"
        ? Reflect.get(entry, "text")
        : undefined,
    )
    .filter(Predicate.isString)
    .join("\n");
}

function displayedCustomMessage(message: PiAgentMessage): PiRuntimeEventDraft | undefined {
  if (message.role !== "custom" || !("display" in message) || message.display !== true) {
    return undefined;
  }
  const text = messageText(message)?.trim();
  if (!text) return undefined;
  return {
    type: "runtime.warning",
    payload: {
      message: boundedText(text, 180),
      detail: {
        customType: "customType" in message ? message.customType : "custom",
        ...(typeof message.details === "undefined"
          ? {}
          : { details: boundPiRuntimeValue(message.details) }),
      },
    },
  };
}

function summaryMessage(message: PiAgentMessage): PiRuntimeEventDraft | undefined {
  if (message.role !== "branchSummary" && message.role !== "compactionSummary") return undefined;
  if (!("summary" in message) || !Predicate.isString(message.summary)) return undefined;
  return {
    type: "runtime.warning",
    payload: {
      message: message.role === "branchSummary" ? "Branch summarized" : "Context compacted",
      detail: {
        summary: boundedText(message.summary),
        ...(message.role === "compactionSummary" && "tokensBefore" in message
          ? { tokensBefore: message.tokensBefore }
          : {}),
      },
    },
  };
}

function bashMessageEvents(message: PiAgentMessage): ReadonlyArray<PiRuntimeEventDraft> {
  if (message.role !== "bashExecution" || !("command" in message)) return [];
  const itemId = RuntimeItemId.make(`pi:bash:${message.timestamp}`);
  const status = message.cancelled ? "declined" : message.exitCode === 0 ? "completed" : "failed";
  return [
    {
      type: "item.started",
      itemId,
      providerRefs: { providerItemId: asProviderItemId(itemId) },
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Command",
        detail: boundedText(message.command, 512),
        data: { command: message.command },
      },
    },
    {
      type: "item.completed",
      itemId,
      providerRefs: { providerItemId: asProviderItemId(itemId) },
      payload: {
        itemType: "command_execution",
        status,
        title: "Command",
        detail: boundedText(message.command, 512),
        data: {
          command: message.command,
          rawOutput: { content: boundedText(message.output, MAX_TOOL_OUTPUT_CHARS) },
          exitCode: message.exitCode,
          cancelled: message.cancelled,
          truncated: message.truncated,
          ...(message.fullOutputPath ? { fullOutputPath: message.fullOutputPath } : {}),
        },
      },
    },
  ];
}

function toolMetadataFor(
  state: PiRuntimeTranslationState,
  toolCallId: string,
  toolName: string,
  args: unknown,
): ToolMetadata {
  const known = state.toolMetadata.get(toolCallId);
  const record = Predicate.isObject(args) ? args : {};
  return {
    name: known?.name ?? toolName,
    args: known?.args ?? record,
    ...(known?.namespace ? { namespace: known.namespace } : {}),
  };
}

function taskId(prefix: string, generation: number, sequence: number): RuntimeTaskId {
  return RuntimeTaskId.make(`pi:${prefix}:${generation}:${sequence}`);
}

export function translatePiRpcEvent(
  state: PiRuntimeTranslationState,
  nativeEvent: PiRpcKnownEvent,
  context: PiTranslationContext,
): PiTranslationResult {
  const events: PiRuntimeEventDraft[] = [];
  resetGeneration(state, context.generation);

  switch (nativeEvent.type) {
    case "agent_start":
    case "turn_start":
    case "queue_update":
    case "entry_appended":
    case "thinking_level_changed":
    case "extension_ui_request":
      break;

    case "session_info_changed":
      if (nativeEvent.name?.trim()) {
        events.push({
          type: "thread.metadata.updated",
          payload: { name: boundedText(nativeEvent.name, 512) },
        });
      }
      break;

    case "agent_end":
      for (const message of nativeEvent.messages) {
        if (isPiAssistantMessage(message)) {
          reconcileAssistantMessage(state, context.generation, message, events);
        }
      }
      break;

    case "turn_end":
      if (isPiAssistantMessage(nativeEvent.message)) {
        reconcileAssistantMessage(state, context.generation, nativeEvent.message, events);
      }
      break;

    case "agent_settled":
      return { events, settlement: state.terminal, reconcileStats: true };

    case "message_start": {
      if (isPiAssistantMessage(nativeEvent.message)) {
        state.messageSequence += 1;
        state.messageOpen = true;
      }
      break;
    }

    case "message_update": {
      const update = nativeEvent.assistantMessageEvent;
      const snapshot = usageSnapshot(nativeEvent.usage, context.contextWindow);
      const fingerprint = snapshot ? JSON.stringify(snapshot) : undefined;
      if (snapshot && fingerprint !== state.lastUsageFingerprint) {
        state.lastUsageFingerprint = fingerprint;
        events.push({ type: "thread.token-usage.updated", payload: { usage: snapshot } });
      }
      if (update.type === "start") {
        ensureMessage(state, context.generation);
      } else if (update.type === "text_start" || update.type === "thinking_start") {
        const block = ensureBlock(
          state,
          context.generation,
          update.type === "text_start" ? "text" : "thinking",
          update.contentIndex,
        );
        const started = startBlock(block);
        if (started) events.push(started);
      } else if (update.type === "text_delta" || update.type === "thinking_delta") {
        const block = ensureBlock(
          state,
          context.generation,
          update.type === "text_delta" ? "text" : "thinking",
          update.contentIndex,
        );
        const started = startBlock(block);
        if (started) events.push(started);
        block.text += update.delta;
        events.push({
          type: "content.delta",
          itemId: block.itemId,
          providerRefs: { providerItemId: asProviderItemId(block.itemId) },
          payload: {
            streamKind: block.kind === "text" ? "assistant_text" : "reasoning_text",
            delta: update.delta,
            contentIndex: update.contentIndex,
          },
        });
      } else if (update.type === "text_end" || update.type === "thinking_end") {
        const block = ensureBlock(
          state,
          context.generation,
          update.type === "text_end" ? "text" : "thinking",
          update.contentIndex,
        );
        appendAuthoritativeBlock(block, update.content ?? block.text, events);
      } else if (update.type === "toolcall_start") {
        state.toolMetadata.set(update.id, { name: update.toolName, args: {} });
      } else if (update.type === "toolcall_delta") {
        // The fragment is intentionally not exposed; toolcall_end carries authoritative arguments.
      } else if (update.type === "toolcall_end") {
        const call: PiToolCallContent = update.toolCall;
        state.toolMetadata.set(call.id, {
          name: call.name,
          args: call.arguments,
          ...(call.namespace ? { namespace: call.namespace } : {}),
        });
      } else if (update.type === "done") {
        reconcileAssistantMessage(state, context.generation, update.message, events);
      } else if (update.type === "error") {
        reconcileAssistantMessage(state, context.generation, update.error, events);
      }
      break;
    }

    case "message_end": {
      const message = nativeEvent.message;
      if (isPiAssistantMessage(message)) {
        reconcileAssistantMessage(state, context.generation, message, events);
      } else if (message.role === "toolResult" && "toolCallId" in message) {
        if (!state.completedTools.has(message.toolCallId)) {
          const metadata = toolMetadataFor(state, message.toolCallId, message.toolName, {});
          const itemId = RuntimeItemId.make(message.toolCallId);
          events.push({
            type: "item.completed",
            itemId,
            providerRefs: { providerItemId: asProviderItemId(itemId) },
            payload: {
              itemType: toolItemType(metadata),
              status: message.isError ? "failed" : "completed",
              title: titleForTool(metadata),
              ...(toolDetail(metadata) ? { detail: toolDetail(metadata) } : {}),
              data: {
                toolCallId: message.toolCallId,
                toolName: metadata.name,
                input: metadata.args,
                result: sanitizeToolResult(message),
              },
            },
          });
          state.completedTools.add(message.toolCallId);
        }
      } else {
        const custom = displayedCustomMessage(message);
        if (custom) events.push(custom);
        const summary = summaryMessage(message);
        if (summary) events.push(summary);
        events.push(...bashMessageEvents(message));
      }
      break;
    }

    case "tool_execution_start": {
      const metadata = toolMetadataFor(
        state,
        nativeEvent.toolCallId,
        nativeEvent.toolName,
        nativeEvent.args,
      );
      state.activeTools.set(nativeEvent.toolCallId, metadata);
      const itemId = RuntimeItemId.make(nativeEvent.toolCallId);
      events.push({
        type: "item.started",
        itemId,
        providerRefs: { providerItemId: asProviderItemId(itemId) },
        payload: {
          itemType: toolItemType(metadata),
          status: "inProgress",
          title: titleForTool(metadata),
          ...(toolDetail(metadata) ? { detail: toolDetail(metadata) } : {}),
          data: {
            toolCallId: nativeEvent.toolCallId,
            toolName: metadata.name,
            input: boundPiRuntimeValue(metadata.args),
            ...(metadata.namespace ? { namespace: metadata.namespace } : {}),
          },
        },
      });
      break;
    }

    case "tool_execution_update": {
      const metadata =
        state.activeTools.get(nativeEvent.toolCallId) ??
        toolMetadataFor(state, nativeEvent.toolCallId, nativeEvent.toolName, nativeEvent.args);
      const itemId = RuntimeItemId.make(nativeEvent.toolCallId);
      events.push({
        type: "item.updated",
        itemId,
        providerRefs: { providerItemId: asProviderItemId(itemId) },
        payload: {
          itemType: toolItemType(metadata),
          status: "inProgress",
          title: titleForTool(metadata),
          ...(toolDetail(metadata) ? { detail: toolDetail(metadata) } : {}),
          data: {
            toolCallId: nativeEvent.toolCallId,
            toolName: metadata.name,
            input: boundPiRuntimeValue(metadata.args),
            rawOutput: toolOutputPreview(nativeEvent.partialResult),
          },
        },
      });
      break;
    }

    case "tool_execution_end": {
      const metadata =
        state.activeTools.get(nativeEvent.toolCallId) ??
        toolMetadataFor(state, nativeEvent.toolCallId, nativeEvent.toolName, {});
      state.activeTools.delete(nativeEvent.toolCallId);
      state.completedTools.add(nativeEvent.toolCallId);
      const itemId = RuntimeItemId.make(nativeEvent.toolCallId);
      events.push({
        type: "item.completed",
        itemId,
        providerRefs: { providerItemId: asProviderItemId(itemId) },
        payload: {
          itemType: toolItemType(metadata),
          status: nativeEvent.isError ? "failed" : "completed",
          title: titleForTool(metadata),
          ...(toolDetail(metadata) ? { detail: toolDetail(metadata) } : {}),
          data: {
            toolCallId: nativeEvent.toolCallId,
            toolName: metadata.name,
            input: boundPiRuntimeValue(metadata.args),
            result: sanitizeToolResult(nativeEvent.result),
          },
        },
      });
      break;
    }

    case "bash_execution_update": {
      const bashId = nativeEvent.id ?? "direct";
      const accumulated = `${state.directBashOutput.get(bashId) ?? ""}${nativeEvent.delta}`;
      const boundedAccumulated =
        accumulated.length <= MAX_TOOL_OUTPUT_CHARS
          ? accumulated
          : accumulated.slice(accumulated.length - MAX_TOOL_OUTPUT_CHARS);
      state.directBashOutput.set(bashId, boundedAccumulated);
      const itemId = RuntimeItemId.make(`pi:bash:${bashId}`);
      events.push({
        type: "item.updated",
        itemId,
        providerRefs: {
          providerItemId: asProviderItemId(itemId),
          ...(nativeEvent.id ? { providerRequestId: nativeEvent.id } : {}),
        },
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "Command",
          data: { rawOutput: { content: boundedAccumulated } },
        },
      });
      break;
    }

    case "compaction_start": {
      state.compactionSequence += 1;
      const id = taskId("compaction", context.generation, state.compactionSequence);
      state.activeCompactionTaskId = id;
      events.push({
        type: "task.started",
        payload: {
          taskId: id,
          taskType: "plan",
          description: `Compacting context (${nativeEvent.reason})`,
          title: "Context compaction",
        },
      });
      break;
    }

    case "compaction_end": {
      const id =
        state.activeCompactionTaskId ??
        taskId("compaction", context.generation, ++state.compactionSequence);
      state.activeCompactionTaskId = undefined;
      const failed = !nativeEvent.aborted && !nativeEvent.result;
      if (failed && !nativeEvent.willRetry) {
        state.terminal = {
          state: "failed",
          stopReason: "error",
          errorMessage: boundedText(nativeEvent.errorMessage ?? "Pi context compaction failed."),
        };
      }
      events.push({
        type: "task.completed",
        payload: {
          taskId: id,
          taskType: "plan",
          title: "Context compaction",
          status: failed ? "failed" : nativeEvent.aborted ? "stopped" : "completed",
          summary: boundedText(
            nativeEvent.errorMessage ??
              (nativeEvent.aborted
                ? "Context compaction cancelled"
                : nativeEvent.willRetry
                  ? "Context compacted; retrying the turn"
                  : "Context compacted"),
            512,
          ),
        },
      });
      if (nativeEvent.result) {
        events.push({
          type: "thread.state.changed",
          payload: {
            state: "compacted",
            detail: {
              reason: nativeEvent.reason,
              tokensBefore: finiteCount(nativeEvent.result.tokensBefore),
              ...(nativeEvent.result.estimatedTokensAfter === undefined
                ? {}
                : {
                    estimatedTokensAfter: finiteCount(nativeEvent.result.estimatedTokensAfter),
                  }),
              willRetry: nativeEvent.willRetry,
            },
          },
        });
      }
      return { events, reconcileStats: nativeEvent.result !== undefined };
    }

    case "auto_retry_start": {
      state.retrySequence += 1;
      const id = taskId("retry", context.generation, state.retrySequence);
      state.activeRetryTaskId = id;
      events.push({
        type: "task.progress",
        payload: {
          taskId: id,
          taskType: "plan",
          title: "Automatic retry",
          description: `Retry ${nativeEvent.attempt} of ${nativeEvent.maxAttempts}`,
          summary: boundedText(nativeEvent.errorMessage, 512),
          attempt: finiteCount(nativeEvent.attempt),
          status: "waiting",
        },
      });
      break;
    }

    case "auto_retry_end": {
      const id =
        state.activeRetryTaskId ?? taskId("retry", context.generation, ++state.retrySequence);
      state.activeRetryTaskId = undefined;
      if (!nativeEvent.success) {
        state.terminal = {
          state: "failed",
          stopReason: "error",
          errorMessage: boundedText(nativeEvent.finalError ?? "Pi automatic retry failed."),
        };
      }
      events.push({
        type: "task.completed",
        payload: {
          taskId: id,
          taskType: "plan",
          title: "Automatic retry",
          status: nativeEvent.success ? "completed" : "failed",
          summary: boundedText(
            nativeEvent.success
              ? `Retry succeeded on attempt ${nativeEvent.attempt}`
              : (nativeEvent.finalError ?? `Retry failed on attempt ${nativeEvent.attempt}`),
            512,
          ),
          attempt: finiteCount(nativeEvent.attempt),
        },
      });
      break;
    }

    case "summarization_retry_scheduled": {
      state.summarizationSequence += 1;
      const id = taskId("summary-retry", context.generation, state.summarizationSequence);
      state.activeSummarizationTaskId = id;
      events.push({
        type: "task.progress",
        payload: {
          taskId: id,
          taskType: "plan",
          title: "Summary retry",
          description: `Summary retry ${nativeEvent.attempt} of ${nativeEvent.maxAttempts}`,
          summary: boundedText(nativeEvent.errorMessage, 512),
          attempt: finiteCount(nativeEvent.attempt),
          status: "waiting",
        },
      });
      break;
    }

    case "summarization_retry_attempt_start": {
      const id =
        state.activeSummarizationTaskId ??
        taskId("summary-retry", context.generation, ++state.summarizationSequence);
      state.activeSummarizationTaskId = id;
      events.push({
        type: "task.progress",
        payload: {
          taskId: id,
          taskType: "plan",
          title: "Summary retry",
          description:
            nativeEvent.source === "compaction"
              ? `Retrying ${nativeEvent.reason ?? "context"} compaction summary`
              : "Retrying branch summary",
          status: "running",
        },
      });
      break;
    }

    case "summarization_retry_finished": {
      const id =
        state.activeSummarizationTaskId ??
        taskId("summary-retry", context.generation, ++state.summarizationSequence);
      state.activeSummarizationTaskId = undefined;
      events.push({
        type: "task.completed",
        payload: {
          taskId: id,
          taskType: "plan",
          title: "Summary retry",
          status: "completed",
          summary: "Summary retry finished",
        },
      });
      break;
    }

    case "extension_error":
      events.push({
        type: "runtime.warning",
        payload: {
          message: boundedText(nativeEvent.error, 512),
          detail: {
            extensionPath: boundedText(nativeEvent.extensionPath, 1_024),
            event: boundedText(nativeEvent.event, 256),
          },
        },
      });
      break;
  }

  return { events };
}
