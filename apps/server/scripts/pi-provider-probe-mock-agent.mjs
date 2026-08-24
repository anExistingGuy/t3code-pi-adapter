import * as NodeProcess from "node:process";

const process = NodeProcess.default;

if (process.argv.includes("--version")) {
  if (process.env.PI_MOCK_VERSION_HANG === "1") {
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write(`${process.env.PI_MOCK_VERSION_OUTPUT ?? "pi 0.52.12"}\n`);
    process.exit(Number(process.env.PI_MOCK_VERSION_EXIT ?? "0"));
  }
}

const defaultModel = {
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
const models = process.env.PI_MOCK_MODELS
  ? JSON.parse(process.env.PI_MOCK_MODELS)
  : process.env.PI_MOCK_NO_MODELS === "1"
    ? []
    : process.env.PI_MOCK_MALFORMED_MODEL === "1"
      ? [{ ...defaultModel, id: "" }]
      : [defaultModel];
const stateModel = process.env.PI_MOCK_STATE_MODEL
  ? JSON.parse(process.env.PI_MOCK_STATE_MODEL)
  : (models[0] ?? null);
const commands = process.env.PI_MOCK_COMMANDS ? JSON.parse(process.env.PI_MOCK_COMMANDS) : [];
let startupDialogPending = process.env.PI_MOCK_STARTUP_DIALOG === "1";
let pendingCommands = [];
let input = "";

function write(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function dataFor(command) {
  switch (command.type) {
    case "get_state":
      return {
        model: stateModel,
        thinkingLevel: process.env.PI_MOCK_THINKING_LEVEL ?? "medium",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        sessionId: "probe-session",
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      };
    case "get_available_models":
      return { models };
    case "get_commands":
      return { commands };
    case "get_available_thinking_levels":
      return {
        levels: process.env.PI_MOCK_THINKING_LEVELS
          ? JSON.parse(process.env.PI_MOCK_THINKING_LEVELS)
          : ["off", "low", "medium", "high"],
      };
    default:
      return undefined;
  }
}

function handle(command) {
  if (command.type === "extension_ui_response") {
    if (startupDialogPending && command.id === "startup-dialog" && command.cancelled === true) {
      startupDialogPending = false;
      const queued = pendingCommands;
      pendingCommands = [];
      for (const pending of queued) handle(pending);
    }
    return;
  }
  if (startupDialogPending) {
    pendingCommands.push(command);
    return;
  }
  if (process.env.PI_MOCK_RPC_HANG === "1") return;
  if (process.env.PI_MOCK_INCOMPATIBLE_RPC === "1" && command.type === "get_state") {
    write({
      id: command.id,
      type: "response",
      command: command.type,
      success: false,
      error: "Unknown command: get_state",
    });
    return;
  }
  const data = dataFor(command);
  write({
    id: command.id,
    type: "response",
    command: command.type,
    success: true,
    ...(data === undefined ? {} : { data }),
  });
}

if (startupDialogPending) {
  write({
    type: "extension_ui_request",
    id: "startup-dialog",
    method: "confirm",
    title: "Startup extension",
    message: "Continue loading?",
  });
}

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
