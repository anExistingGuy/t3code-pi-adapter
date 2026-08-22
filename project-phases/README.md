# Pi provider implementation phases

This directory is the implementation handoff for adding Pi (`https://pi.dev`) as a first-class T3 Code provider. It is intentionally detailed so each phase can be implemented without rediscovering the provider architecture across the repository.

## Product goal

Run the user's installed `pi` CLI inside T3 Code while preserving Pi's defining advantages:

- upstream-provider and model agnosticism;
- user extensions, custom providers, tools, skills, prompt templates, context files, and settings;
- Pi's durable tree sessions, compaction, retries, steering, and model switching;
- T3 Code's web/desktop/mobile workflow, remote connectivity, checkpoints, inline approvals, and canonical activity model.

T3 Code is a client of Pi's documented RPC mode. It must not reimplement Pi's agent loop or bundle Pi as a library.

## Non-negotiable invariants

1. **Spawn the user's CLI.** The configured executable defaults to `pi`. Do not add `@earendil-works/pi-coding-agent` as a T3 runtime dependency.
2. **Use RPC mode.** Launch `pi --mode rpc`; do not parse TUI output or session JSONL as the primary live protocol.
3. **Keep Pi extensible.** Do not pass `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-context-files`, or `--no-builtin-tools` during normal sessions. The T3 permission bridge is an additional explicit `-e` extension, not a replacement extension set.
4. **Do not hardcode upstream models.** Discover Pi's authenticated model inventory through `get_available_models`. T3 model slugs use `provider/model-id` and are split only at the Pi RPC boundary.
5. **Do not replace Pi's system prompt.** T3 may append narrowly scoped integration guidance if proven necessary, but Pi continues to load its own system prompt, AGENTS.md files, extensions, and skills.
6. **Respect Pi project trust.** Do not force `--approve`. Pi's saved trust decision and non-interactive fallback remain authoritative. T3's own explicit `-e` bridge still loads.
7. **Preserve history.** Resume a same-cwd session by absolute session file. If the T3 thread moves to another cwd/worktree, fork the Pi session into the new cwd rather than starting empty.
8. **Never silently reset on transport failure.** A fresh session is allowed only when no cursor exists or the cursor's session file is confirmed missing. Malformed cursors may be ignored with a warning. Other resume/start failures surface to the thread.
9. **One process per active T3 thread.** A process owns one Pi session and is scoped to the provider adapter session. Provider instance scopes own all remaining processes and probe resources.
10. **Forward-compatible protocol handling.** Decode the fields T3 needs, ignore unknown Pi records/events, and preserve useful raw events only through an explicit contracts source.
11. **No invented Pi plan mode.** Pi deliberately has no built-in plan mode. The first implementation does not expose T3's provider interaction-mode toggle for Pi. User-installed Pi plan-mode extensions remain usable through their commands where RPC permits.
12. **No repo-wide verification.** Use focused tests and typechecks listed in each phase.

## Baseline protocol

Planning used Pi `0.84.2` and its documented strict LF-delimited JSONL RPC protocol. Relevant commands/events:

- Commands: `prompt`, `abort`, `get_state`, `set_model`, `set_thinking_level`, `get_available_models`, `get_commands`, `get_entries`, `fork`, `get_messages`, and `extension_ui_response`.
- Responses: `{ type: "response", id, command, success, data? | error? }`.
- Completion signal: `agent_settled`, not `agent_end`.
- Streaming: `message_update.assistantMessageEvent` with text/thinking/tool-call deltas.
- Tool lifecycle: `tool_execution_start`, `tool_execution_update`, `tool_execution_end`.
- User interaction: `extension_ui_request` methods `select`, `confirm`, `input`, `editor`, plus fire-and-forget methods.
- Sessions: `get_state` returns `sessionFile` and `sessionId`; `fork` creates and switches to a new session file before a chosen user message.

Protocol clients must split only on byte-decoded `\n`; Node `readline` is not compliant because it also recognizes Unicode separators.

## Phase order

| Phase | Document | Depends on |
|---|---|---|
| 1 | [Contracts and provider registration](./01-contracts-and-registration.md) | none |
| 2 | [Pi RPC transport](./02-pi-rpc-transport.md) | none; may run parallel with phase 1 |
| 3 | [Sessions and canonical event adapter](./03-session-and-event-adapter.md) | 1, 2 |
| 4 | [Permissions and extension UI](./04-permissions-and-extension-ui.md) | 2, 3 |
| 5 | [Discovery, driver, and text generation](./05-discovery-driver-text-generation.md) | 1-4 |
| 6 | [Web, desktop, and mobile surfaces](./06-client-surfaces.md) | 1, 5 |
| 7 | [Documentation and integrated verification](./07-docs-and-verification.md) | 1-6 |

Phases should land in order unless one pull request deliberately contains the whole feature. Keep each phase internally usable and tested; do not temporarily make Pi the default provider.

## Main architectural anchors

Implementers should read only the phase document and the directly referenced files. The important existing anchors are:

- Driver SPI: `apps/server/src/provider/ProviderDriver.ts`
- Built-in registration: `apps/server/src/provider/builtInDrivers.ts`
- Adapter contract: `apps/server/src/provider/Services/ProviderAdapter.ts`
- Representative scoped driver: `apps/server/src/provider/Drivers/OpenCodeDriver.ts`
- Representative event/session adapter: `apps/server/src/provider/Layers/OpenCodeAdapter.ts`
- Provider snapshot helpers: `apps/server/src/provider/providerSnapshot.ts`
- Settings contracts: `packages/contracts/src/settings.ts`
- Provider/runtime contracts: `packages/contracts/src/provider.ts`, `packages/contracts/src/providerRuntime.ts`
- Client provider metadata: `apps/web/src/components/settings/providerDriverMeta.ts`

Before writing Effect code, follow `.repos/effect-smol/LLMS.md`. Use `Effect.gen`/`Effect.fn`, typed errors, scopes/finalizers, and `Schema` decoding at untrusted protocol boundaries.
