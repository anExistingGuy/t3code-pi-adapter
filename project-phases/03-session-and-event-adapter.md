# Phase 3: Sessions and canonical event adapter

## Outcome

`makePiAdapter` implements `ProviderAdapterShape`: one Pi RPC process per active T3 thread, durable resume/fork behavior, model switching, steering, interruption, canonical activity events, snapshots, rollback, and cleanup.

## Suggested files

- `apps/server/src/provider/Layers/PiAdapter.ts`
- `apps/server/src/provider/Layers/PiAdapter.test.ts`
- `apps/server/src/provider/Services/PiAdapter.ts` (shape only)
- optional pure helpers in `apps/server/src/provider/pi/PiEventMapping.ts` and tests

Follow `OpenCodeAdapter.ts` for per-session scopes/maps/queues, but map Pi's documented event protocol rather than OpenCode SDK events.

## Session context

Keep one mutable context per T3 `ThreadId`:

```ts
interface PiSessionContext {
  session: ProviderSession;
  connection: PiRpcConnectionShape;
  sessionScope: Scope.Closeable;
  activeTurnId?: TurnId;
  activeModel?: { provider: string; modelId: string };
  activeThinkingLevel?: PiThinkingLevel;
  piSessionFile?: string;
  piSessionId: string;
  cwd: string;
  turns: PiTurnSnapshot[];
  pendingUiRequests: Map<string, PendingPiUiRequest>;
  stopped: Ref<boolean>;
}
```

The adapter owns an unbounded `Queue<ProviderRuntimeEvent>` and exposes `Stream.fromQueue` through `streamEvents`. Add a finalizer that stops all contexts, then shuts down the queue and any adapter-owned logger.

## Resume cursor

Define and schema-decode this versioned cursor:

```ts
{
  schemaVersion: 1,
  sessionFile: string,
  sessionId: string,
  cwd: string
}
```

Rules:

1. No cursor or malformed cursor: start a new persisted Pi session; malformed data also emits a warning.
2. Cursor file exists and requested cwd is equivalent: launch `--session <absolute sessionFile>`.
3. Cursor file exists and cwd differs: launch `--fork <absolute sessionFile>` with the new process cwd. This copies the active branch and avoids Pi's cross-project interactive confirmation path.
4. Cursor file is confirmed absent: log/emit a warning and start fresh.
5. File probe, spawn, auth, RPC, or session-open errors other than confirmed absence: fail `startSession`; never silently reset.

After spawn, call `get_state`. Require `sessionId`; normal sessions must also return `sessionFile`. Build the returned `ProviderSession.resumeCursor` from authoritative state, not the requested cursor.

Use lexical resolved paths first and `FileSystem.realPath` when possible to compare cwd, as `isSameOpenCodeDirectory` does.

## Model and thinking selection

Parse T3's Pi model slug on the first slash:

```ts
anthropic/claude-sonnet-4-6 -> { provider: "anthropic", modelId: "claude-sonnet-4-6" }
openrouter/qwen/qwen3-coder -> { provider: "openrouter", modelId: "qwen/qwen3-coder" }
```

Reject missing/empty sides with `ProviderAdapterValidationError`.

At session start, pass the model to the CLI and verify state. Before each idle turn:

- if the selected provider/model differs, call `set_model`;
- read `thinkingLevel` from model option ID `thinkingLevel` and call `set_thinking_level` when changed;
- Pi clamps levels according to model capability, so the snapshot builder must only advertise levels derived for that model.

Declare `capabilities.sessionModelSwitch = "in-session"`.

## Sending turns and steering

For an idle context:

1. create a new T3 `TurnId`;
2. set session status `running` and active turn;
3. emit `turn.started` with model/effort;
4. send RPC `prompt` with text and images;
5. return the durable resume cursor immediately after Pi accepts the command.

For an already-running context, treat `sendTurn` as steering:

- reuse `activeTurnId`;
- send `prompt` with `streamingBehavior: "steer"`;
- do not emit a second `turn.started`.

Pi's prompt response means accepted/queued, not completed. Completion is event-driven.

Images are the only current `ChatAttachment` type. Resolve each through `resolveAttachmentPath`, read it, base64 encode it, and send `{type:"image", data, mimeType}`. Enforce existing contract count/size/MIME validation; do not put attachment paths in the user prompt.

`interactionMode` is ignored only when absent/default. If `plan` somehow reaches Pi, return a clear validation error in the initial release rather than pretending Pi entered plan mode.

## Event mapping

Create event IDs with `Crypto.randomUUIDv4`, timestamps with `DateTime`, and attach `raw.source = "pi.rpc.event"` where appropriate.

### Agent/session lifecycle

| Pi record | Canonical behavior |
|---|---|
| `agent_start` | mark running; normally no second `turn.started` |
| `agent_end` | informational only; do not complete the T3 turn because retry/compaction/follow-up may continue |
| `agent_settled` | clear active turn, set session ready, emit `turn.completed {state:"completed"}` |
| process exit while active | emit failed `turn.completed`, `runtime.error`, and `session.exited` once |
| graceful adapter stop | emit `session.exited` with `exitKind:"graceful"` |
| `auto_retry_start/end` | runtime warning/progress; final failed retry completes the turn as failed if Pi does not settle normally |
| `compaction_start/end` | canonical context-compaction item start/completion plus warning on failure |
| `extension_error` | `runtime.warning` unless it terminates the agent |

Terminal assistant `message_end` with stop reason `error`, `length`, or `aborted` should retain useful detail. Avoid double-completing when `agent_settled` follows.

### Assistant content

For `message_update.assistantMessageEvent`:

- `text_delta` -> `content.delta`, `streamKind:"assistant_text"`;
- `thinking_delta` -> `content.delta`, `streamKind:"reasoning_text"`;
- start/end markers update local item state but need not emit empty deltas;
- completed assistant `message_end` -> `item.completed` with `itemType:"assistant_message"` when a stable item can be correlated.

Use Pi `contentIndex` and message/tool IDs where present. Never synthesize a new item ID for every delta.

### Tool lifecycle

Map `tool_execution_start/update/end` by `toolCallId`:

- `bash` or names containing command/shell/terminal -> `command_execution`;
- `edit`, `write`, patch/multiedit names -> `file_change`;
- web/search/browser names -> `web_search`;
- image/view names -> `image_view`;
- task/agent/subagent names -> `collab_agent_tool_call` only when the payload actually describes child-agent work; otherwise `dynamic_tool_call`;
- all unknown extension tools -> `dynamic_tool_call`.

Start emits `item.started`, updates emit `item.updated`, end emits `item.completed` with `completed` or `failed`. Keep bounded output/detail summaries; never place unbounded tool results on websocket events.

### Token usage

Pi message updates/end include usage fields `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, and cost. Map a valid positive snapshot to `thread.token-usage.updated`:

- `usedTokens`: best available current context usage, falling back to `input + cacheRead + cacheWrite + output`;
- `inputTokens`, `cachedInputTokens`, `outputTokens` where known;
- `maxTokens`: selected model's `contextWindow` from state/discovery;
- keep total-processed semantics separate from current context usage.

Do not emit zero snapshots because ingestion deliberately ignores them.

## Read and rollback

`readThread` calls `get_entries` and groups the active session branch into turns. At minimum, each assistant message closes one turn and includes its assistant/tool-result entries as raw snapshot items. Store T3 turn IDs locally for the live process; after restart deterministic IDs may be derived from stable Pi entry IDs.

`rollbackThread(threadId, numTurns)` must mutate Pi's conversation:

1. call `get_entries`;
2. derive the active sequence and identify the first user-message entry belonging to the last `numTurns` completed turns;
3. call RPC `fork` with that user entry. Pi forks **before** the chosen user message, which removes that user turn and everything after it;
4. call `get_state`, update session file/ID/cursor;
5. return a fresh `readThread` snapshot.

Reject non-positive or excessive rollback counts consistently with other adapters. If there is no user entry to fork before, use `new_session` only when rollback semantics explicitly mean an empty conversation; test this edge against checkpoint revert behavior before implementing it.

## Request responses

Phase 4 fills the UI request maps. In this phase methods may return typed unknown-request errors when no pending request exists; they must not silently succeed.

## Tests

Use a fake `PiRpcConnection` rather than a real Pi CLI. Cover:

- new, same-cwd resumed, moved-cwd forked, missing-file fresh, malformed cursor, and transient resume failure;
- authoritative cursor returned at start and every turn;
- upstream provider/model parsing with nested model slashes;
- model/thinking switch only when changed;
- idle prompt vs running steer;
- image conversion and validation;
- text/thinking/tool/usage mapping;
- retry/compaction and authoritative `agent_settled` completion;
- unexpected exit emits lifecycle once;
- `readThread` grouping and rollback fork target;
- stop one/all and adapter scope finalization.

## Acceptance criteria

A T3 thread can run several Pi turns, be reaped/restarted, resume the same Pi session, move into a worktree without losing history, stream canonical activity, switch any discovered Pi model, and participate in checkpoint rollback.
