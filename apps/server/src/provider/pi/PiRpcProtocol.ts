import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const PiThinkingLevel = Schema.Literals(PI_THINKING_LEVELS);
export type PiThinkingLevel = typeof PiThinkingLevel.Type;

export const PiQueueMode = Schema.Literals(["all", "one-at-a-time"]);
export type PiQueueMode = typeof PiQueueMode.Type;

export const PiImageContent = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});
export type PiImageContent = typeof PiImageContent.Type;

export const PiTextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  textSignature: Schema.optional(Schema.String),
});

export const PiThinkingContent = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  thinkingSignature: Schema.optional(Schema.String),
  redacted: Schema.optional(Schema.Boolean),
});

export const PiToolCallContent = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  thoughtSignature: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
});

export const PiUsage = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  cacheWrite1h: Schema.optional(Schema.Number),
  reasoning: Schema.optional(Schema.Number),
  totalTokens: Schema.Number,
  cost: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    cacheRead: Schema.Number,
    cacheWrite: Schema.Number,
    total: Schema.Number,
  }),
});
export type PiUsage = typeof PiUsage.Type;

export const PiUserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Union([
    Schema.String,
    Schema.Array(Schema.Union([PiTextContent, PiImageContent])),
  ]),
  timestamp: Schema.Number,
  attachments: Schema.optional(Schema.Array(Schema.Unknown)),
});

export const PiAssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Union([PiTextContent, PiThinkingContent, PiToolCallContent])),
  api: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  usage: PiUsage,
  stopReason: Schema.String,
  timestamp: Schema.Number,
  errorMessage: Schema.optional(Schema.String),
});

export const PiToolResultMessage = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  content: Schema.Array(Schema.Union([PiTextContent, PiImageContent])),
  details: Schema.optional(Schema.Unknown),
  usage: Schema.optional(PiUsage),
  isError: Schema.Boolean,
  timestamp: Schema.Number,
});

export const PiBashExecutionMessage = Schema.Struct({
  role: Schema.Literal("bashExecution"),
  command: Schema.String,
  output: Schema.String,
  exitCode: Schema.Number,
  cancelled: Schema.Boolean,
  truncated: Schema.Boolean,
  fullOutputPath: Schema.optional(Schema.NullOr(Schema.String)),
  timestamp: Schema.Number,
});

/** Extensions may add custom message roles, so preserve an unknown fallback. */
export const PiAgentMessage = Schema.Union([
  PiUserMessage,
  PiAssistantMessage,
  PiToolResultMessage,
  PiBashExecutionMessage,
  Schema.Struct({ role: Schema.String }),
]);
export type PiAgentMessage = typeof PiAgentMessage.Type;

export const PiModel = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  api: Schema.String,
  provider: Schema.NonEmptyString,
  baseUrl: Schema.String,
  reasoning: Schema.Boolean,
  input: Schema.Array(Schema.String),
  contextWindow: Schema.Number,
  maxTokens: Schema.Number,
  cost: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    cacheRead: Schema.Number,
    cacheWrite: Schema.Number,
  }),
  thinkingLevelMap: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
});
export type PiModel = typeof PiModel.Type;

const command = <Type extends string, Fields extends Schema.Struct.Fields>(
  type: Type,
  fields: Fields,
) => Schema.Struct({ id: Schema.optional(Schema.String), type: Schema.Literal(type), ...fields });

export const PiRpcCommand = Schema.Union([
  command("prompt", {
    message: Schema.String,
    images: Schema.optional(Schema.Array(PiImageContent)),
    streamingBehavior: Schema.optional(Schema.Literals(["steer", "followUp"])),
  }),
  command("steer", {
    message: Schema.String,
    images: Schema.optional(Schema.Array(PiImageContent)),
  }),
  command("follow_up", {
    message: Schema.String,
    images: Schema.optional(Schema.Array(PiImageContent)),
  }),
  command("abort", {}),
  command("new_session", { parentSession: Schema.optional(Schema.String) }),
  command("get_state", {}),
  command("get_messages", {}),
  command("set_model", { provider: Schema.String, modelId: Schema.String }),
  command("cycle_model", {}),
  command("get_available_models", {}),
  command("set_thinking_level", { level: PiThinkingLevel }),
  command("cycle_thinking_level", {}),
  command("get_available_thinking_levels", {}),
  command("set_steering_mode", { mode: PiQueueMode }),
  command("set_follow_up_mode", { mode: PiQueueMode }),
  command("compact", { customInstructions: Schema.optional(Schema.String) }),
  command("set_auto_compaction", { enabled: Schema.Boolean }),
  command("set_auto_retry", { enabled: Schema.Boolean }),
  command("abort_retry", {}),
  command("bash", { command: Schema.String, excludeFromContext: Schema.optional(Schema.Boolean) }),
  command("abort_bash", {}),
  command("get_session_stats", {}),
  command("export_html", { outputPath: Schema.optional(Schema.String) }),
  command("switch_session", { sessionPath: Schema.String }),
  command("fork", { entryId: Schema.String }),
  command("clone", {}),
  command("get_fork_messages", {}),
  command("get_entries", { since: Schema.optional(Schema.String) }),
  command("get_tree", {}),
  command("get_last_assistant_text", {}),
  command("set_session_name", { name: Schema.String }),
  command("get_commands", {}),
]);
export type PiRpcCommand = typeof PiRpcCommand.Type;
export type PiRpcCommandType = PiRpcCommand["type"];
type WithoutId<Entry> = Entry extends unknown ? Omit<Entry, "id"> : never;
export type PiRpcCommandWithoutId = WithoutId<PiRpcCommand>;

export const PI_RPC_COMMAND_TYPES = [
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "new_session",
  "get_state",
  "get_messages",
  "set_model",
  "cycle_model",
  "get_available_models",
  "set_thinking_level",
  "cycle_thinking_level",
  "get_available_thinking_levels",
  "set_steering_mode",
  "set_follow_up_mode",
  "compact",
  "set_auto_compaction",
  "set_auto_retry",
  "abort_retry",
  "bash",
  "abort_bash",
  "get_session_stats",
  "export_html",
  "switch_session",
  "fork",
  "clone",
  "get_fork_messages",
  "get_entries",
  "get_tree",
  "get_last_assistant_text",
  "set_session_name",
  "get_commands",
] as const satisfies ReadonlyArray<PiRpcCommandType>;

export const PiRpcResponseEnvelope = Schema.Union([
  Schema.Struct({
    id: Schema.optional(Schema.String),
    type: Schema.Literal("response"),
    command: Schema.String,
    success: Schema.Literal(true),
    data: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    id: Schema.optional(Schema.String),
    type: Schema.Literal("response"),
    command: Schema.String,
    success: Schema.Literal(false),
    error: Schema.String,
  }),
]);
export type PiRpcResponseEnvelope = typeof PiRpcResponseEnvelope.Type;

export const PiRpcResponseHint = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.optional(Schema.String),
  command: Schema.String,
});

export const PiSessionState = Schema.Struct({
  model: Schema.optional(Schema.NullOr(PiModel)),
  thinkingLevel: PiThinkingLevel,
  isStreaming: Schema.Boolean,
  isCompacting: Schema.Boolean,
  steeringMode: PiQueueMode,
  followUpMode: PiQueueMode,
  sessionFile: Schema.optional(Schema.String),
  sessionId: Schema.String,
  sessionName: Schema.optional(Schema.String),
  autoCompactionEnabled: Schema.Boolean,
  messageCount: Schema.Number,
  pendingMessageCount: Schema.Number,
});

export const PiCompactionResult = Schema.Struct({
  summary: Schema.String,
  firstKeptEntryId: Schema.String,
  tokensBefore: Schema.Number,
  estimatedTokensAfter: Schema.Number,
  usage: Schema.optional(PiUsage),
  details: Schema.optional(Schema.Unknown),
});

export const PiSessionEntry = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
});
export type PiSessionEntry = typeof PiSessionEntry.Type;

export interface PiSessionTreeNode {
  readonly entry: PiSessionEntry;
  readonly children: ReadonlyArray<PiSessionTreeNode>;
  readonly label?: string | undefined;
  readonly labelTimestamp?: string | undefined;
}

export const PiSessionTreeNode: Schema.Schema<PiSessionTreeNode> = Schema.suspend(() =>
  Schema.Struct({
    entry: PiSessionEntry,
    children: Schema.Array(PiSessionTreeNode),
    label: Schema.optional(Schema.String),
    labelTimestamp: Schema.optional(Schema.String),
  }),
);

export const PiSourceInfo = Schema.Struct({
  path: Schema.String,
  source: Schema.String,
  scope: Schema.Literals(["user", "project", "temporary"]),
  origin: Schema.Literals(["package", "top-level"]),
  baseDir: Schema.optional(Schema.String),
});
export type PiSourceInfo = typeof PiSourceInfo.Type;

export const PiSlashCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  source: Schema.Literals(["extension", "prompt", "skill"]),
  sourceInfo: Schema.optional(PiSourceInfo),
  // Kept for compatibility with older Pi RPC payloads.
  location: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
});
export type PiSlashCommand = typeof PiSlashCommand.Type;

export const PiBashResult = Schema.Struct({
  output: Schema.String,
  exitCode: Schema.Number,
  cancelled: Schema.Boolean,
  truncated: Schema.Boolean,
  fullOutputPath: Schema.optional(Schema.String),
});

export const PiSessionStats = Schema.Struct({
  sessionFile: Schema.optional(Schema.String),
  sessionId: Schema.String,
  userMessages: Schema.Number,
  assistantMessages: Schema.Number,
  toolCalls: Schema.Number,
  toolResults: Schema.Number,
  totalMessages: Schema.Number,
  tokens: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    cacheRead: Schema.Number,
    cacheWrite: Schema.Number,
    total: Schema.Number,
  }),
  cost: Schema.Number,
  contextUsage: Schema.optional(
    Schema.Struct({
      tokens: Schema.NullOr(Schema.Number),
      contextWindow: Schema.Number,
      percent: Schema.NullOr(Schema.Number),
    }),
  ),
});

const responseDataSchemas = {
  prompt: Schema.Void,
  steer: Schema.Void,
  follow_up: Schema.Void,
  abort: Schema.Void,
  new_session: Schema.Struct({ cancelled: Schema.Boolean }),
  get_state: PiSessionState,
  get_messages: Schema.Struct({ messages: Schema.Array(PiAgentMessage) }),
  set_model: PiModel,
  cycle_model: Schema.NullOr(
    Schema.Struct({ model: PiModel, thinkingLevel: PiThinkingLevel, isScoped: Schema.Boolean }),
  ),
  get_available_models: Schema.Struct({ models: Schema.Array(PiModel) }),
  set_thinking_level: Schema.Void,
  cycle_thinking_level: Schema.NullOr(Schema.Struct({ level: PiThinkingLevel })),
  get_available_thinking_levels: Schema.Struct({ levels: Schema.Array(PiThinkingLevel) }),
  set_steering_mode: Schema.Void,
  set_follow_up_mode: Schema.Void,
  compact: PiCompactionResult,
  set_auto_compaction: Schema.Void,
  set_auto_retry: Schema.Void,
  abort_retry: Schema.Void,
  bash: PiBashResult,
  abort_bash: Schema.Void,
  get_session_stats: PiSessionStats,
  export_html: Schema.Struct({ path: Schema.String }),
  switch_session: Schema.Struct({ cancelled: Schema.Boolean }),
  fork: Schema.Struct({ text: Schema.String, cancelled: Schema.Boolean }),
  clone: Schema.Struct({ cancelled: Schema.Boolean }),
  get_fork_messages: Schema.Struct({
    messages: Schema.Array(Schema.Struct({ entryId: Schema.String, text: Schema.String })),
  }),
  get_entries: Schema.Struct({
    entries: Schema.Array(PiSessionEntry),
    leafId: Schema.NullOr(Schema.String),
  }),
  get_tree: Schema.Struct({
    tree: Schema.Array(PiSessionTreeNode),
    leafId: Schema.NullOr(Schema.String),
  }),
  get_last_assistant_text: Schema.Struct({ text: Schema.NullOr(Schema.String) }),
  set_session_name: Schema.Void,
  get_commands: Schema.Struct({ commands: Schema.Array(PiSlashCommand) }),
} as const satisfies Record<PiRpcCommandType, Schema.Top>;

export type PiRpcResponseData<Type extends PiRpcCommandType> =
  (typeof responseDataSchemas)[Type]["Type"];

export const decodePiRpcResponseData = <Type extends PiRpcCommandType>(
  type: Type,
  data: unknown,
): Effect.Effect<PiRpcResponseData<Type>, Schema.SchemaError> => {
  const schema = responseDataSchemas[type] as Schema.Codec<
    PiRpcResponseData<Type>,
    unknown,
    never,
    never
  >;
  return Schema.decodeUnknownEffect(schema, { onExcessProperty: "preserve" })(data);
};

export const PiExtensionUiRequest = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("select"),
    title: Schema.String,
    options: Schema.Array(Schema.String),
    timeout: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("confirm"),
    title: Schema.String,
    message: Schema.String,
    timeout: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("input"),
    title: Schema.String,
    placeholder: Schema.optional(Schema.String),
    timeout: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("editor"),
    title: Schema.String,
    prefill: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("notify"),
    message: Schema.String,
    notifyType: Schema.optional(Schema.Literals(["info", "warning", "error"])),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("setStatus"),
    statusKey: Schema.String,
    statusText: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("setWidget"),
    widgetKey: Schema.String,
    widgetLines: Schema.optional(Schema.Array(Schema.String)),
    widgetPlacement: Schema.optional(Schema.Literals(["aboveEditor", "belowEditor"])),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("setTitle"),
    title: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("set_editor_text"),
    text: Schema.String,
  }),
]);
export type PiExtensionUiRequest = typeof PiExtensionUiRequest.Type;

export const PiExtensionUiResponse = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("extension_ui_response"),
    id: Schema.String,
    value: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_response"),
    id: Schema.String,
    confirmed: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_response"),
    id: Schema.String,
    cancelled: Schema.Literal(true),
  }),
]);
export type PiExtensionUiResponse = typeof PiExtensionUiResponse.Type;

const baseEvent = <Type extends string, Fields extends Schema.Struct.Fields>(
  type: Type,
  fields: Fields,
) => Schema.Struct({ type: Schema.Literal(type), ...fields });

const assistantDelta = Schema.Union([
  baseEvent("start", {}),
  baseEvent("text_start", { contentIndex: Schema.Number }),
  baseEvent("text_delta", { contentIndex: Schema.Number, delta: Schema.String }),
  baseEvent("text_end", { contentIndex: Schema.Number, content: Schema.optional(Schema.String) }),
  baseEvent("thinking_start", { contentIndex: Schema.Number }),
  baseEvent("thinking_delta", { contentIndex: Schema.Number, delta: Schema.String }),
  baseEvent("thinking_end", {
    contentIndex: Schema.Number,
    content: Schema.optional(Schema.String),
  }),
  baseEvent("toolcall_start", { contentIndex: Schema.Number }),
  baseEvent("toolcall_delta", { contentIndex: Schema.Number, delta: Schema.String }),
  baseEvent("toolcall_end", { contentIndex: Schema.Number, toolCall: PiToolCallContent }),
  baseEvent("done", {
    reason: Schema.Literals(["stop", "length", "toolUse", "deferred"]),
    message: PiAssistantMessage,
  }),
  baseEvent("error", {
    reason: Schema.Literals(["aborted", "error"]),
    error: PiAssistantMessage,
  }),
]);

export const PiRpcKnownEvent = Schema.Union([
  baseEvent("agent_start", {}),
  baseEvent("agent_end", { messages: Schema.Array(PiAgentMessage), willRetry: Schema.Boolean }),
  baseEvent("agent_settled", {}),
  baseEvent("turn_start", {}),
  baseEvent("turn_end", {
    message: PiAgentMessage,
    toolResults: Schema.Array(PiToolResultMessage),
  }),
  baseEvent("message_start", { message: PiAgentMessage }),
  baseEvent("message_update", { usage: PiUsage, assistantMessageEvent: assistantDelta }),
  baseEvent("message_end", { message: PiAgentMessage }),
  baseEvent("bash_execution_update", { id: Schema.optional(Schema.String), delta: Schema.String }),
  baseEvent("tool_execution_start", {
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Unknown,
  }),
  baseEvent("tool_execution_update", {
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Unknown,
    partialResult: Schema.Unknown,
  }),
  baseEvent("tool_execution_end", {
    toolCallId: Schema.String,
    toolName: Schema.String,
    result: Schema.Unknown,
    isError: Schema.Boolean,
  }),
  baseEvent("queue_update", {
    steering: Schema.Array(Schema.String),
    followUp: Schema.Array(Schema.String),
  }),
  baseEvent("compaction_start", { reason: Schema.Literals(["manual", "threshold", "overflow"]) }),
  baseEvent("compaction_end", {
    reason: Schema.Literals(["manual", "threshold", "overflow"]),
    result: Schema.optional(Schema.NullOr(PiCompactionResult)),
    aborted: Schema.Boolean,
    willRetry: Schema.Boolean,
    errorMessage: Schema.optional(Schema.String),
  }),
  baseEvent("auto_retry_start", {
    attempt: Schema.Number,
    maxAttempts: Schema.Number,
    delayMs: Schema.Number,
    errorMessage: Schema.String,
  }),
  baseEvent("auto_retry_end", {
    success: Schema.Boolean,
    attempt: Schema.Number,
    finalError: Schema.optional(Schema.String),
  }),
  baseEvent("summarization_retry_scheduled", {
    attempt: Schema.Number,
    maxAttempts: Schema.Number,
    delayMs: Schema.Number,
    errorMessage: Schema.String,
  }),
  baseEvent("summarization_retry_attempt_start", {
    source: Schema.Literals(["compaction", "branchSummary"]),
    reason: Schema.optional(Schema.Literals(["manual", "threshold", "overflow"])),
  }),
  baseEvent("summarization_retry_finished", {}),
  baseEvent("extension_error", {
    extensionPath: Schema.String,
    event: Schema.String,
    error: Schema.String,
  }),
  baseEvent("entry_appended", { entry: PiSessionEntry }),
  baseEvent("session_info_changed", { name: Schema.optional(Schema.String) }),
  baseEvent("thinking_level_changed", { level: PiThinkingLevel }),
  PiExtensionUiRequest,
]);
export type PiRpcKnownEvent = typeof PiRpcKnownEvent.Type;

export const PI_RPC_KNOWN_EVENT_TYPES = new Set<string>([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "bash_execution_update",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "extension_error",
  "entry_appended",
  "session_info_changed",
  "thinking_level_changed",
  "extension_ui_request",
]);

export interface PiRpcUnknownEvent {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export const decodePiRpcKnownEvent = Schema.decodeUnknownEffect(PiRpcKnownEvent, {
  onExcessProperty: "preserve",
});
export const decodePiRpcResponseEnvelope = Schema.decodeUnknownEffect(PiRpcResponseEnvelope, {
  onExcessProperty: "preserve",
});
export const decodePiRpcResponseHint = Schema.decodeUnknownEffect(PiRpcResponseHint, {
  onExcessProperty: "preserve",
});
export const decodePiRpcCommand = Schema.decodeUnknownEffect(PiRpcCommand, {
  onExcessProperty: "preserve",
});
export const decodePiExtensionUiResponse = Schema.decodeUnknownEffect(PiExtensionUiResponse, {
  onExcessProperty: "preserve",
});
export const decodePiRpcJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown), {
  onExcessProperty: "preserve",
});
export const decodePiRpcTypedRecord = Schema.decodeUnknownEffect(
  Schema.Struct({ type: Schema.String }),
  { onExcessProperty: "preserve" },
);
