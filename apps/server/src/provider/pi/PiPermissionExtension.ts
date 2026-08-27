import type { RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const PI_PERMISSION_PROTOCOL_VERSION = "t3-pi-permission-v1";
export const PI_PERMISSION_MARKER_ENV = "T3_PI_PERMISSION_MARKER";
export const PI_PERMISSION_MODE_ENV = "T3_PI_PERMISSION_MODE";
export const PI_PERMISSION_CWD_ENV = "T3_PI_PERMISSION_CWD";
export const PI_PERMISSION_PROTOCOL_ENV = "T3_PI_PERMISSION_PROTOCOL";
export const PI_PERMISSION_OPTIONS = ["Allow once", "Allow for this session", "Deny"] as const;

export const PI_PERMISSION_EXTENSION_FILE = "t3-pi-permission-gate-v1.mjs";

export function piPermissionGateRequired(mode: RuntimeMode): boolean {
  return mode !== "full-access";
}

/** Dependency-free source written into T3-owned state for source and packaged servers alike. */
export const PI_PERMISSION_EXTENSION_SOURCE = `
const VERSION = ${JSON.stringify(PI_PERMISSION_PROTOCOL_VERSION)};
const OPTIONS = ${JSON.stringify(PI_PERMISSION_OPTIONS)};
const READ_TOOLS = new Set(["read", "grep", "find", "ls", "view", "image_view"]);
const EDIT_TOOLS = new Set(["write", "edit", "apply_patch", "apply-patch", "patch"]);
const SENSITIVE_KEY = /(?:secret|token|password|credential|authorization|api.?key|private.?key)/i;

function sanitizeString(value) {
  return value
    .replace(/((?:api[_-]?key|token|password|secret|authorization)\\s*[=:]\\s*)[^\\s,;]+/gi, "$1[redacted]")
    .replace(/(bearer\\s+)[a-z0-9._~+/-]+/gi, "$1[redacted]");
}

function bounded(value, depth = 0) {
  if (depth > 3) return "[truncated]";
  if (typeof value === "string") {
    const sanitized = sanitizeString(value);
    return sanitized.length > 256 ? sanitized.slice(0, 256) + "…" : sanitized;
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 12).map((entry) => bounded(entry, depth + 1));
  if (typeof value !== "object") return String(value).slice(0, 256);
  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, 24)) {
    result[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : bounded(entry, depth + 1);
  }
  return result;
}

function shouldAsk(mode, toolName) {
  if (READ_TOOLS.has(toolName)) return false;
  if (mode === "auto-accept-edits" && EDIT_TOOLS.has(toolName)) return false;
  return true;
}

function requestPayload(event, cwd) {
  const input = bounded(event.input);
  let preview;
  try { preview = JSON.stringify(input); } catch { preview = "[unavailable]"; }
  if (preview.length > 1200) preview = preview.slice(0, 1200) + "…";
  return {
    version: VERSION,
    toolName: String(event.toolName).slice(0, 128),
    toolCallId: String(event.toolCallId || "").slice(0, 256),
    cwd: String(cwd || "").slice(0, 1024),
    input,
    summary: (String(event.toolName) + (preview === "{}" ? "" : ": " + preview)).slice(0, 1600),
  };
}

export default function (pi) {
  const marker = process.env.${PI_PERMISSION_MARKER_ENV};
  const mode = process.env.${PI_PERMISSION_MODE_ENV} || "approval-required";
  const cwd = process.env.${PI_PERMISSION_CWD_ENV} || "";
  const protocol = process.env.${PI_PERMISSION_PROTOCOL_ENV};
  const sessionGrants = new Set();

  pi.on("tool_call", async (event, ctx) => {
    const toolName = String(event.toolName || "");
    if (!marker || protocol !== VERSION || !shouldAsk(mode, toolName) || sessionGrants.has(toolName)) {
      return undefined;
    }
    if (!ctx.hasUI) return { block: true, reason: "T3 approval required but no UI is available" };

    const payload = requestPayload(event, cwd);
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const choice = await ctx.ui.select(marker + ":" + encoded, OPTIONS);
    if (choice === OPTIONS[1]) {
      sessionGrants.add(toolName);
      return undefined;
    }
    if (choice === OPTIONS[0]) return undefined;
    return { block: true, reason: choice === OPTIONS[2] ? "Tool denied by user" : "Tool approval cancelled" };
  });
}
`.trimStart();

export const materializePiPermissionExtension = Effect.fn("materializePiPermissionExtension")(
  function* (stateDir: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(stateDir, "provider-assets", "pi");
    const assetPath = path.join(directory, PI_PERMISSION_EXTENSION_FILE);
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    const current = yield* fileSystem.readFileString(assetPath).pipe(Effect.option);
    if (current._tag === "None" || current.value !== PI_PERMISSION_EXTENSION_SOURCE) {
      yield* fileSystem.writeFileString(assetPath, PI_PERMISSION_EXTENSION_SOURCE);
    }
    return assetPath;
  },
);
