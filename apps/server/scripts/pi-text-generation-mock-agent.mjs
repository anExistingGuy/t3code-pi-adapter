import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";

const process = NodeProcess.default;
const logPath = process.env.PI_TEXT_MOCK_LOG;
const launchArgs = process.argv.slice(2);
let input = "";
let pendingPrompt;
let thinkingLevel = valueAfter("--thinking") ?? "medium";
let model = {
  id: valueAfter("--model") ?? "mock-model",
  name: "Mock Model",
  api: "mock-api",
  provider: valueAfter("--provider") ?? "mock-provider",
  baseUrl: "http://localhost.invalid",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 100000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function valueAfter(flag) {
  const index = launchArgs.indexOf(flag);
  return index < 0 ? undefined : launchArgs[index + 1];
}
function log(value) {
  if (logPath)
    NodeFS.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...value })}\n`);
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
function usage() {
  return {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
function assistantMessage(stopReason, text) {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "mock-api",
    provider: model.provider,
    model: model.id,
    usage: usage(),
    stopReason,
    timestamp: Date.now(),
    ...(stopReason === "error" ? { errorMessage: "mock provider failure" } : {}),
  };
}
function state() {
  return {
    model,
    thinkingLevel,
    isStreaming: false,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    sessionId: "mock-ephemeral",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  };
}
function generate() {
  const behavior = process.env.PI_TEXT_MOCK_BEHAVIOR ?? "success";
  if (behavior === "hang") return;
  if (behavior === "crash") {
    process.stderr.write("mock text generation crash");
    process.exitCode = 7;
    process.stdin.destroy();
    return;
  }
  const finalText = process.env.PI_TEXT_MOCK_OUTPUT ?? JSON.stringify({ title: "Pi RPC title" });
  const delta = process.env.PI_TEXT_MOCK_DELTA ?? finalText;
  const stopReason = behavior === "error" ? "error" : behavior === "aborted" ? "aborted" : "stop";
  write({ type: "agent_start" });
  write({
    type: "message_update",
    usage: usage(),
    assistantMessageEvent:
      stopReason === "stop"
        ? { type: "text_delta", contentIndex: 0, delta }
        : { type: "error", reason: stopReason, error: assistantMessage(stopReason, finalText) },
  });
  write({ type: "message_end", message: assistantMessage(stopReason, finalText) });
  write({ type: "agent_settled" });
}
function handle(command) {
  log({ kind: "command", command });
  if (command.type === "extension_ui_response") {
    if (command.id === "prompt-dialog" && pendingPrompt) {
      pendingPrompt = undefined;
      generate();
    }
    return;
  }
  switch (command.type) {
    case "get_state":
      response(command, state());
      return;
    case "set_model":
      model = { ...model, provider: command.provider, id: command.modelId, name: command.modelId };
      response(command, model);
      return;
    case "get_available_thinking_levels":
      response(command, { levels: ["off", "low", "medium", "high", "max"] });
      return;
    case "set_thinking_level":
      thinkingLevel = command.level;
      response(command);
      return;
    case "prompt":
      response(command);
      if (process.env.PI_TEXT_MOCK_DIALOG === "1") {
        pendingPrompt = command;
        write({
          type: "extension_ui_request",
          id: "prompt-dialog",
          method: "confirm",
          title: "Utility dialog",
          message: "Continue?",
        });
        return;
      }
      generate();
      return;
    case "get_last_assistant_text":
      response(command, {
        text:
          process.env.PI_TEXT_MOCK_BEHAVIOR === "empty"
            ? null
            : (process.env.PI_TEXT_MOCK_OUTPUT ?? JSON.stringify({ title: "Pi RPC title" })),
      });
      return;
    default:
      response(command);
  }
}

log({ kind: "argv", argv: launchArgs, cwd: process.cwd() });
process.stdin.on("data", (chunk) => {
  input += chunk.toString("utf8");
  while (true) {
    const newline = input.indexOf("\n");
    if (newline < 0) break;
    const line = input.slice(0, newline).replace(/\r$/, "");
    input = input.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => {
  log({ kind: "closed" });
  process.exit(0);
});
