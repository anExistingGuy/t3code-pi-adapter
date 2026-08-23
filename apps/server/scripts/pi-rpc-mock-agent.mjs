import * as NodeProcess from "node:process";

const process = NodeProcess.default;

let input = "";
let pendingOutOfOrder = [];
let extensionResponses = 0;
let lateResponse;

const model = {
  id: "mock-model",
  name: "Mock Model",
  api: "mock-api",
  provider: "mock-provider",
  baseUrl: "http://localhost.invalid",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 100000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function responseData(command) {
  switch (command.type) {
    case "new_session":
      return { cancelled: false };
    case "get_state":
      return {
        model,
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        sessionFile: "/mock/session.jsonl",
        sessionId: "mock-session",
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      };
    case "get_messages":
      return { messages: [] };
    case "set_model":
      return model;
    case "cycle_model":
      return { model, thinkingLevel: "medium", isScoped: false };
    case "get_available_models":
      return { models: [model] };
    case "cycle_thinking_level":
      return { level: "high" };
    case "get_available_thinking_levels":
      return { levels: ["off", "low", "high"] };
    case "compact":
      return {
        summary: "mock summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 10,
        estimatedTokensAfter: 2,
        details: {},
      };
    case "bash":
      return command.command === "extension-count"
        ? { output: String(extensionResponses), exitCode: 0, cancelled: false, truncated: false }
        : { output: command.command, exitCode: 0, cancelled: false, truncated: false };
    case "get_session_stats":
      return {
        sessionFile: "/mock/session.jsonl",
        sessionId: "mock-session",
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      };
    case "export_html":
      return { path: command.outputPath ?? "/mock/session.html" };
    case "switch_session":
      return { cancelled: false };
    case "fork":
      return { text: "fork text", cancelled: false };
    case "clone":
      return { cancelled: false };
    case "get_fork_messages":
      return { messages: [{ entryId: "entry-1", text: "first" }] };
    case "get_entries":
      return { entries: [], leafId: null };
    case "get_tree":
      return { tree: [], leafId: null };
    case "get_last_assistant_text":
      return { text: "mock assistant" };
    case "get_commands":
      return {
        commands: [
          {
            name: "skill:test",
            description: "Test skill",
            source: "skill",
            location: "project",
            path: "/mock/SKILL.md",
          },
        ],
      };
    default:
      return undefined;
  }
}

function writeRecord(record, options = {}) {
  const ending = options.crlf ? "\r\n" : "\n";
  const bytes = Buffer.from(`${JSON.stringify(record)}${ending}`, "utf8");
  if (!options.chunked) {
    process.stdout.write(bytes);
    return;
  }
  for (const byte of bytes) process.stdout.write(Buffer.from([byte]));
}

function respond(command, options) {
  const data = responseData(command);
  writeRecord(
    {
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      ...(data === undefined ? {} : { data }),
    },
    options,
  );
}

function handle(command) {
  if (lateResponse && command.type !== "extension_ui_response") {
    respond(lateResponse);
    lateResponse = undefined;
  }
  if (command.type === "extension_ui_response") {
    extensionResponses += 1;
    if (command.cancelled === true) process.stderr.write(`cancelled:${command.id}`);
    return;
  }
  if (command.type === "prompt" && command.message === "late-response") {
    lateResponse = command;
    writeRecord({ type: "queue_update", steering: [], followUp: [] });
    return;
  }
  if (command.type === "prompt" && command.message === "malformed-response") {
    writeRecord({ id: command.id, type: "response", command: "prompt", success: "yes" });
    return;
  }
  if (command.type === "prompt" && command.message === "fail-command") {
    writeRecord({
      id: command.id,
      type: "response",
      command: "prompt",
      success: false,
      error: "mock rejection",
    });
    return;
  }
  if (command.type === "prompt" && command.message === "oversized-record") {
    process.stdout.write("x".repeat(1000));
    setInterval(() => {}, 1000);
    return;
  }
  if (command.type === "prompt" && command.message === "hang-on-eof") {
    setInterval(() => {}, 1000);
    respond(command);
    return;
  }
  if (command.type === "prompt" && command.message === "final-no-lf") {
    const record = { id: command.id, type: "response", command: "prompt", success: true };
    process.stdout.write(JSON.stringify(record));
    process.exitCode = 0;
    process.stdin.destroy();
    return;
  }
  if (command.type === "prompt" && command.message === "exit-pending") {
    process.stderr.write("mock-stderr-" + "x".repeat(10000));
    process.exitCode = 7;
    process.stdin.destroy();
    return;
  }
  if (command.type === "prompt" && command.message === "events") {
    process.stdout.write("\nnot-json\n");
    writeRecord({
      type: "tool_execution_end",
      toolCallId: "bad",
      toolName: "bash",
      isError: "false",
    });
    writeRecord({ type: "future_event", value: 42 });
    writeRecord(
      {
        type: "message_update",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "line\u2028paragraph\u2029🥧",
        },
      },
      { chunked: true, crlf: true },
    );
    respond(command);
    return;
  }
  if (command.type === "prompt" && command.message === "dialog") {
    writeRecord({
      type: "extension_ui_request",
      id: "dialog-1",
      method: "confirm",
      title: "Continue?",
      message: "Confirm",
    });
    respond(command);
    return;
  }
  if (process.env.PI_MOCK_OUT_OF_ORDER === "1" && command.type === "get_state") {
    pendingOutOfOrder.push(command);
    if (pendingOutOfOrder.length === 2) {
      respond(pendingOutOfOrder[1]);
      respond(pendingOutOfOrder[0]);
      pendingOutOfOrder = [];
    }
    return;
  }
  respond(command);
}

process.stdin.on("data", (chunk) => {
  input += chunk.toString("utf8");
  while (true) {
    const newline = input.indexOf("\n");
    if (newline === -1) break;
    let line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length > 0) handle(JSON.parse(line));
  }
});
