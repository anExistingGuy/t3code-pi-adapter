# Phase 4: Permissions and extension UI

## Outcome

Pi keeps its extension system, while T3 runtime modes and arbitrary Pi RPC dialogs work through T3's existing inline approval and structured-input UI.

Pi intentionally has no built-in permission popups. The bridge therefore uses Pi's supported extension API instead of modifying Pi or disabling its user extensions.

## Bundled bridge extension

Create an embedded JavaScript module source, for example:

- `apps/server/src/provider/pi/PiT3BridgeExtension.ts` — exports source text and a version/hash;
- `apps/server/src/provider/pi/PiT3BridgeExtension.test.ts`;
- materialization helper writes `<ServerConfig.stateDir>/pi/t3-bridge-v<version>.mjs` atomically.

Materialize once per server/provider scope. The path must work in packaged desktop/server builds; do not depend on source-tree files being present after bundling. The generated extension should use no third-party imports and receive the Pi API through its default factory argument.

Normal sessions append `-e <absolute bridge path>`. Probe and text-generation sessions do not need the bridge unless they explicitly test extension UI.

### Environment contract

Pass only non-secret integration configuration:

- `T3_PI_RUNTIME_MODE`: `approval-required`, `auto-accept-edits`, `auto`, or `full-access`;
- optional `T3_PI_BRIDGE_VERSION` for diagnostics.

Do not pass websocket tokens, T3 auth grants, or server origins to Pi.

## Runtime-mode behavior

The extension subscribes to `tool_call` and composes with all other user extensions.

| T3 mode | Pi bridge policy |
|---|---|
| `full-access` | bridge allows all calls; user Pi extensions may still block/ask |
| `approval-required` (Supervised) | reads/list/search are allowed; commands, writes/edits, and unknown custom tools ask |
| `auto-accept-edits` | built-in edit/write/file-change tools are allowed; commands and unknown custom tools ask |
| `auto` | fall back to Supervised, matching T3's documented behavior for providers without a native auto reviewer |

Unknown extension tools must default to asking outside full access because their side effects cannot be inferred safely. Maintain small explicit allowlists for known read-only built-ins (`read`, `grep`, `find`, `ls`) and known file mutations (`edit`, `write`). Names alone are advisory; do not broadly allow every tool containing `read`.

The extension asks with `ctx.ui.confirm` using a machine-recognizable title prefix, for example:

```text
T3_PI_TOOL_APPROVAL:<request-kind>:<tool-call-id>
```

The human-readable message includes tool name and a bounded, JSON-formatted argument summary. It must not dump base64 data or arbitrarily large content. A false/cancel response returns `{ block: true, reason: "Declined by user" }`.

Do not implement shell-command risk heuristics in the first version. T3's modes are explicit and predictable; a partial parser would create false confidence.

## Adapter handling of extension UI

Pi emits `extension_ui_request` records. Keep pending requests in the owning `PiSessionContext`, keyed by Pi request ID.

### Tool approvals

Recognize only the bridge's exact title prefix as a T3 approval. Emit:

```ts
{
  type: "request.opened",
  requestId: ApprovalRequestId.make(piRequest.id),
  payload: {
    requestType: "command_execution_approval" | "file_change_approval" | "dynamic_tool_call",
    detail: boundedMessage,
    args: boundedParsedArgs
  }
}
```

Map to T3's projection-facing request kind through existing ingestion:

- command -> `command`;
- file mutation -> `file-change`;
- dynamic custom tool -> safest supported request kind (normally `command` unless contracts gain a dynamic kind).

`respondToRequest` maps decisions:

- `accept` -> `extension_ui_response {confirmed:true}`;
- `acceptForSession` -> same response and remember approval for the request category/tool in this Pi session;
- `decline` or `cancel` -> `{confirmed:false}`.

For remembered approvals, future matching bridge requests are answered automatically and still emit `request.resolved` if needed for coherent activity. Clear remembered approvals when the provider session stops or runtime mode changes/restarts.

Emit `request.resolved` after successfully writing the response, not when the user merely clicks.

### Arbitrary Pi extension dialogs

Preserve Pi extensibility by supporting every documented dialog method:

- `select`: one `UserInputQuestion` with options from `request.options`, `multiSelect:false`;
- `confirm` not owned by the T3 bridge: one yes/no question;
- `input`: one free-text question using title/placeholder;
- `editor`: one free-text/multiline question using title/prefill.

Emit `user-input.requested` with a stable question ID derived from the Pi request ID. Store enough method metadata to convert `ProviderUserInputAnswers` back:

- select/input/editor -> `{type:"extension_ui_response", id, value:string}`;
- confirm -> `{..., confirmed:boolean}`;
- empty/cancelled T3 response -> `{..., cancelled:true}`.

Then emit `user-input.resolved`.

If T3's current structured question UI cannot represent free text or confirmation exactly, extend the smallest canonical question contract rather than presenting a fake option. That contract change must update web and mobile together.

### Fire-and-forget UI methods

- `notify`: map warning/error notifications to `runtime.warning`/`runtime.error`; informational notices may become bounded work-log info or native logs.
- `setStatus`, `setWidget`, `setTitle`, `set_editor_text`: initially log/ignore unless a clear T3 surface exists. They must not block Pi or be misrepresented as approvals.
- Unknown future UI methods: emit a warning and answer cancellation only if Pi is waiting for a response.

Honor Pi-provided dialog timeouts. If the request expires before T3 responds, remove it and make a late T3 response return a typed unknown/expired request error.

## Runtime-mode changes

T3 may change mode on an existing thread. Provider orchestration normally restarts/rebinds a provider session with its resume cursor when runtime configuration changes. Confirm this path in a focused test. The restarted Pi process receives the new environment mode and resumes the same history.

Do not make the bridge read a mutable file on every tool call merely to avoid process restart.

## User extension composition

Ordering matters:

- T3 bridge is loaded explicitly with `-e` alongside auto-discovered user extensions.
- A user extension may block before or after the T3 bridge depending on Pi load order. Never override a block returned by another extension.
- If another extension asks its own dialog, treat it as arbitrary extension UI, not a T3 permission, unless it uses the exact reserved bridge prefix.
- T3 must not filter custom tool lifecycle events; unknown tools remain visible as dynamic tools.

## Tests

### Extension unit/fixture tests

Run the materialized `.mjs` against a tiny fake Pi API and verify:

- every runtime-mode/tool-category decision;
- `auto` equals Supervised;
- unknown tools ask;
- bounded/redacted argument messages;
- decline blocks;
- full access does not invoke UI;
- source/version materialization is deterministic and atomic.

### Adapter tests

Verify:

- bridge confirmation -> canonical approval;
- all four T3 decisions;
- `acceptForSession` auto-answer behavior;
- select/confirm/input/editor round trips;
- timeout and late-response behavior;
- notify mapping;
- unknown UI methods do not wedge the session;
- two concurrent UI requests correlate correctly;
- pending requests are cancelled/cleared on stop and process exit.

## Acceptance criteria

- Pi remains fully extension-capable.
- Supervised and Auto modes do not silently run mutations.
- Auto-accept edits permits Pi's built-in file edits without prompts but still gates commands/custom tools.
- Full access adds no T3 confirmation overhead.
- A third-party Pi extension can ask a supported dialog and receive the user's answer from either web/desktop or mobile.
