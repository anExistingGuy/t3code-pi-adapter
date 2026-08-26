import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";

const process = NodeProcess.default;
const logPath = process.env.PI_ADAPTER_MOCK_LOG;
const startupDialog = process.env.PI_ADAPTER_MOCK_STARTUP_DIALOG === "1";
let input = "";
let streaming = false;
let pendingCount = 0;
let crashRequested = false;
let delayedState;
let startupDialogEmitted = false;
let leafCounter = 0;
let model = {
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
let thinkingLevel = "medium";
const launchArgs = process.argv.slice(2);
const providerIndex = launchArgs.indexOf("--provider");
const modelIndex = launchArgs.indexOf("--model");
const thinkingIndex = launchArgs.indexOf("--thinking");
if (providerIndex >= 0 && launchArgs[providerIndex + 1])
  model.provider = launchArgs[providerIndex + 1];
if (modelIndex >= 0 && launchArgs[modelIndex + 1]) model.id = launchArgs[modelIndex + 1];
if (thinkingIndex >= 0 && launchArgs[thinkingIndex + 1])
  thinkingLevel = launchArgs[thinkingIndex + 1];

function log(value) {
  if (logPath) NodeFS.appendFileSync(logPath, `${JSON.stringify(value)}\n`);
}
function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function response(command, data) {
  write({
    id: command.id,
    type: "response",
    command: command.type,
    success: true,
    ...(data === undefined ? {} : { data }),
  });
}
function state() {
  return {
    model,
    thinkingLevel,
    isStreaming: streaming,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    sessionFile: "/mock/persistent-session.jsonl",
    sessionId: "mock-persistent-session",
    autoCompactionEnabled: true,
    messageCount: leafCounter,
    pendingMessageCount: pendingCount,
  };
}
function settle() {
  streaming = false;
  pendingCount = 0;
  write({ type: "agent_settled" });
}
function usage(input = 100, output = 20) {
  return {
    input,
    output,
    cacheRead: 10,
    cacheWrite: 0,
    reasoning: 5,
    totalTokens: input + output + 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
function assistantMessage(stopReason = "stop") {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Mock reasoning" },
      { type: "text", text: "Mock answer" },
      {
        type: "toolCall",
        id: "mock-extension-tool",
        name: "extension_magic",
        arguments: { target: "fixture" },
      },
    ],
    api: "mock-api",
    provider: model.provider,
    model: model.id,
    usage: usage(),
    stopReason,
    timestamp: Date.now(),
  };
}
function emitCanonicalFixture() {
  const message = assistantMessage();
  streaming = true;
  write({ type: "agent_start" });
  write({ type: "turn_start" });
  write({ type: "message_start", message: { ...message, content: [] } });
  write({
    type: "message_update",
    usage: { ...usage(0, 0), cacheRead: 0, totalTokens: 0 },
    assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
  });
  write({
    type: "message_update",
    usage: usage(),
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "Mock reasoning",
    },
  });
  write({
    type: "message_update",
    usage: usage(),
    assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Mock reasoning" },
  });
  write({
    type: "message_update",
    usage: usage(),
    assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Mock" },
  });
  write({
    type: "message_update",
    usage: usage(),
    assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "Mock answer" },
  });
  write({
    type: "message_update",
    usage: usage(),
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 2,
      toolCall: message.content[2],
    },
  });
  write({
    type: "tool_execution_start",
    toolCallId: "mock-extension-tool",
    toolName: "extension_magic",
    args: { target: "fixture" },
  });
  write({
    type: "tool_execution_update",
    toolCallId: "mock-extension-tool",
    toolName: "extension_magic",
    args: { target: "fixture" },
    partialResult: { content: [{ type: "text", text: "partial output" }] },
  });
  write({
    type: "tool_execution_end",
    toolCallId: "mock-extension-tool",
    toolName: "extension_magic",
    result: { content: [{ type: "text", text: "final output" }], details: { fixture: true } },
    isError: false,
  });
  write({ type: "message_end", message });
  write({ type: "turn_end", message, toolResults: [] });
  write({ type: "agent_end", messages: [message], willRetry: false });
  settle();
}
function handle(command) {
  log({ kind: "command", command });
  if (command.type === "extension_ui_response") {
    if (command.id === "startup-dialog" && delayedState) {
      const stateCommand = delayedState;
      delayedState = undefined;
      response(stateCommand, state());
    }
    return;
  }
  switch (command.type) {
    case "get_state":
      if (startupDialog && !startupDialogEmitted) {
        startupDialogEmitted = true;
        delayedState = command;
        write({
          type: "extension_ui_request",
          id: "startup-dialog",
          method: "confirm",
          title: "Initialize?",
          message: "Allow startup",
        });
        return;
      }
      response(command, state());
      return;
    case "set_steering_mode":
    case "set_follow_up_mode":
    case "abort_retry":
      response(command);
      return;
    case "get_commands":
      response(command, {
        commands: [
          { name: "instant", description: "Instant command", source: "extension" },
          {
            name: "skill:test",
            description: "Test skill",
            source: "skill",
            path: "/mock/SKILL.md",
          },
        ],
      });
      return;
    case "get_entries":
      response(command, { entries: [], leafId: leafCounter === 0 ? null : `leaf-${leafCounter}` });
      if (crashRequested) {
        process.stderr.write("mock lifecycle crash");
        process.exitCode = 7;
        process.stdin.destroy();
      }
      return;
    case "get_session_stats":
      response(command, {
        sessionFile: "/mock/persistent-session.jsonl",
        sessionId: "mock-persistent-session",
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 1,
        toolResults: 1,
        totalMessages: 4,
        tokens: { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, total: 130 },
        cost: 0,
        contextUsage: { tokens: 130, contextWindow: model.contextWindow, percent: 0.13 },
      });
      return;
    case "get_available_thinking_levels":
      response(command, { levels: ["off", "low", "high", "max"] });
      return;
    case "set_model":
      model = { ...model, provider: command.provider, id: command.modelId, name: command.modelId };
      response(command, model);
      return;
    case "set_thinking_level":
      thinkingLevel = command.level;
      response(command);
      write({ type: "thinking_level_changed", level: thinkingLevel });
      return;
    case "prompt":
      response(command);
      if (command.message.startsWith("/instant")) return;
      if (command.message === "events") {
        emitCanonicalFixture();
        return;
      }
      streaming = true;
      leafCounter += 1;
      write({ type: "agent_start" });
      write({
        type: "entry_appended",
        entry: {
          type: "message",
          id: `leaf-${leafCounter}`,
          parentId: leafCounter === 1 ? null : `leaf-${leafCounter - 1}`,
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      });
      if (command.message === "complete") settle();
      if (command.message === "crash") crashRequested = true;
      return;
    case "steer":
      pendingCount += 1;
      response(command);
      write({ type: "queue_update", steering: [command.message], followUp: [] });
      return;
    case "follow_up":
      pendingCount += 1;
      response(command);
      write({ type: "queue_update", steering: [], followUp: [command.message] });
      return;
    case "abort":
      response(command);
      settle();
      return;
    default:
      response(command);
  }
}

log({ kind: "argv", argv: process.argv.slice(2), cwd: process.cwd() });
process.stdin.on("data", (chunk) => {
  input += chunk.toString("utf8");
  while (true) {
    const newline = input.indexOf("\n");
    if (newline === -1) break;
    const line = input.slice(0, newline).replace(/\r$/, "");
    input = input.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});
