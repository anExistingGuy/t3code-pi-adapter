import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";

const process = NodeProcess.default;
const logPath = process.env.PI_ADAPTER_MOCK_LOG;
const startupDialog = process.env.PI_ADAPTER_MOCK_STARTUP_DIALOG;
const startupDialogTimeout = process.env.PI_ADAPTER_MOCK_DIALOG_TIMEOUT;
const dialogCrash = process.env.PI_ADAPTER_MOCK_DIALOG_CRASH === "1";
const permissionTool = process.env.PI_ADAPTER_MOCK_PERMISSION_TOOL;
const emitUiEvents = process.env.PI_ADAPTER_MOCK_UI_EVENTS === "1";
let input = "";
let streaming = false;
let pendingCount = 0;
let crashRequested = false;
let delayedState;
let delayedFork;
let startupDialogEmitted = false;
let leafCounter = 0;
let forkCounter = 0;
let entries = process.env.PI_ADAPTER_MOCK_ENTRIES
  ? JSON.parse(process.env.PI_ADAPTER_MOCK_ENTRIES)
  : [];
leafCounter = entries.length;
let sessionFile = "/mock/persistent-session.jsonl";
let sessionId = "mock-persistent-session";
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
const sessionIndex = launchArgs.indexOf("--session");
if (providerIndex >= 0 && launchArgs[providerIndex + 1])
  model.provider = launchArgs[providerIndex + 1];
if (modelIndex >= 0 && launchArgs[modelIndex + 1]) model.id = launchArgs[modelIndex + 1];
if (thinkingIndex >= 0 && launchArgs[thinkingIndex + 1])
  thinkingLevel = launchArgs[thinkingIndex + 1];
if (sessionIndex >= 0 && launchArgs[sessionIndex + 1]) {
  sessionFile = launchArgs[sessionIndex + 1];
  const forkMatch = sessionFile.match(/\/fork-(\d+)\.jsonl$/);
  if (forkMatch) sessionId = `mock-fork-${forkMatch[1]}`;
}

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
    sessionFile,
    sessionId,
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
function handleFork(command) {
  const selectedIndex = entries.findIndex((entry) => entry.id === command.entryId);
  const selected = entries[selectedIndex];
  if (selectedIndex < 0 || selected?.message?.role !== "user") {
    write({
      id: command.id,
      type: "response",
      command: command.type,
      success: false,
      error: "Invalid entry ID for forking",
    });
    return;
  }
  if (process.env.PI_ADAPTER_MOCK_FORK_CANCEL === "1") {
    response(command, { text: selected.message.content, cancelled: true });
    return;
  }
  forkCounter += 1;
  entries = entries.slice(0, selectedIndex);
  leafCounter = entries.length;
  sessionFile = `/mock/fork-${forkCounter}.jsonl`;
  sessionId = `mock-fork-${forkCounter}`;
  response(command, { text: selected.message.content, cancelled: false });
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
    if (command.id === "fork-dialog" && delayedFork) {
      const forkCommand = delayedFork;
      delayedFork = undefined;
      handleFork(forkCommand);
    }
    return;
  }
  switch (command.type) {
    case "get_state":
      if (startupDialog && !startupDialogEmitted) {
        startupDialogEmitted = true;
        delayedState = command;
        const method = startupDialog === "1" ? "confirm" : startupDialog;
        write({
          type: "extension_ui_request",
          id: "startup-dialog",
          method,
          title: "Initialize?",
          ...(method === "confirm" ? { message: "Allow startup" } : {}),
          ...(method === "select" ? { options: ["Alpha", "Beta"] } : {}),
          ...(method === "input" ? { placeholder: "Type a value" } : {}),
          ...(method === "editor" ? { prefill: "Line 1\nLine 2" } : {}),
          ...(startupDialogTimeout ? { timeout: Number(startupDialogTimeout) } : {}),
        });
        if (dialogCrash) {
          process.exitCode = 8;
          process.stdin.destroy();
        }
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
          { name: "switch", description: "Replace session", source: "extension" },
          {
            name: "skill:test",
            description: "Test skill",
            source: "skill",
            path: "/mock/SKILL.md",
          },
        ],
      });
      return;
    case "get_entries": {
      const sinceIndex = command.since
        ? entries.findIndex((entry) => entry.id === command.since)
        : -1;
      if (command.since && sinceIndex < 0) {
        write({
          id: command.id,
          type: "response",
          command: command.type,
          success: false,
          error: `Unknown entry cursor: ${command.since}`,
        });
        return;
      }
      response(command, {
        entries: command.since ? entries.slice(sinceIndex + 1) : entries,
        leafId: entries.at(-1)?.id ?? null,
      });
      if (crashRequested) {
        process.stderr.write("mock lifecycle crash");
        process.exitCode = 7;
        process.stdin.destroy();
      }
      return;
    }
    case "get_fork_messages":
      response(command, {
        messages: entries
          .filter((entry) => entry.type === "message" && entry.message?.role === "user")
          .map((entry) => ({ entryId: entry.id, text: entry.message.content })),
      });
      return;
    case "fork":
      if (process.env.PI_ADAPTER_MOCK_FORK_DIALOG === "1") {
        delayedFork = command;
        write({
          type: "extension_ui_request",
          id: "fork-dialog",
          method: "confirm",
          title: "Fork session?",
          message: "Allow native fork lifecycle",
        });
        return;
      }
      handleFork(command);
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
      if (command.message === "ui-events" && emitUiEvents) {
        write({
          type: "extension_ui_request",
          id: "notify-1",
          method: "notify",
          message: "Extension warning",
          notifyType: "error",
        });
        for (let index = 0; index < 2; index += 1) {
          write({
            type: "extension_ui_request",
            id: `status-${index}`,
            method: "setStatus",
            statusKey: "mock",
            statusText: "Ready",
          });
          write({
            type: "extension_ui_request",
            id: `widget-${index}`,
            method: "setWidget",
            widgetKey: "mock",
            widgetLines: ["One", "Two"],
          });
          write({
            type: "extension_ui_request",
            id: `editor-${index}`,
            method: "set_editor_text",
            text: "Suggested prompt",
          });
        }
        write({
          type: "extension_ui_request",
          id: "title-1",
          method: "setTitle",
          title: "Extension title",
        });
      }
      if (command.message === "permission" && permissionTool) {
        const marker = process.env.T3_PI_PERMISSION_MARKER;
        const payload = Buffer.from(
          JSON.stringify({
            version: "t3-pi-permission-v1",
            toolName: permissionTool,
            toolCallId: "permission-tool-1",
            cwd: process.cwd(),
            input: permissionTool === "bash" ? { command: "pnpm test" } : { value: "test" },
            summary: `${permissionTool}: test request`,
          }),
          "utf8",
        ).toString("base64url");
        write({
          type: "extension_ui_request",
          id: "permission-dialog",
          method: "select",
          title: `${marker}:${payload}`,
          options: ["Allow once", "Allow for this session", "Deny"],
        });
      }
      if (command.message.startsWith("/instant")) return;
      if (command.message.startsWith("/switch")) {
        entries = [];
        leafCounter = 0;
        sessionFile = "/mock/extension-session.jsonl";
        sessionId = "mock-extension-session";
        return;
      }
      if (command.message === "events") {
        emitCanonicalFixture();
        return;
      }
      streaming = true;
      leafCounter += 1;
      const entry = {
        type: "message",
        id: `leaf-${leafCounter}`,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: command.message, timestamp: Date.now() },
      };
      entries.push(entry);
      write({ type: "agent_start" });
      write({ type: "entry_appended", entry });
      if (command.message.startsWith("complete")) settle();
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
