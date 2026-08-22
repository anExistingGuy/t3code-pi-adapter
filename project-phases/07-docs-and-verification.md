# Phase 7: Documentation and integrated verification

## Outcome

The feature is documented in shipped-product language, architecture docs describe the sixth built-in driver, and focused integration evidence proves normal/resumed/remote workflows without touching live T3 state.

## User documentation

### `docs/user/install.md`

Add Pi to the agent table:

- product: Pi;
- executable: `pi`;
- install: `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` (keep synchronized with `https://pi.dev`);
- authentication: launch `pi`, then `/login`, or configure any Pi-supported API key/provider.

Update the enabled-by-default sentence: Pi is off by default initially, alongside optional providers. Explain that Pi must be installed on the environment hosting T3, not on a remote browser/mobile client.

### New `docs/user/providers-pi.md`

Cover:

1. **What the integration is:** T3 controls Pi through RPC while Pi remains the model/tool/extension harness.
2. **Basic setup:** install Pi, authenticate/configure models, enable Pi in Settings, select a discovered model.
3. **Model agnosticism:** model list comes from Pi and includes custom providers/extensions; T3 names models as upstream provider/model.
4. **Pi home:** empty uses normal `~/.pi/agent`; custom `PI_CODING_AGENT_DIR path` isolates credentials/settings/sessions for work/personal instances.
5. **Extensions/resources:** user/global and trusted project extensions, skills, prompts, AGENTS.md, SYSTEM.md, and custom model providers continue to load. T3 adds one permission bridge extension.
6. **Project trust:** T3 does not auto-trust project `.pi` resources; Pi's saved/default project trust applies in RPC mode.
7. **Sessions/worktrees:** T3 persists Pi's session and forks it when moving to another worktree, preserving active history.
8. **Permission modes:**
   - Supervised asks on commands/file changes/custom tools;
   - Auto-accept edits allows built-in edits, asks for commands/custom tools;
   - Auto falls back to Supervised because Pi has no native reviewer;
   - Full access adds no T3 gate, though user extensions may still gate.
9. **Plan mode:** no T3 plan toggle initially; Pi plan-mode packages/commands remain Pi extensions and may work when invokable through RPC.
10. **Troubleshooting:** binary path, no available models/auth, custom home mismatch, project resources ignored due to trust, extension dialog, stale/missing session.
11. **Remote behavior:** Pi runs on the T3 environment; web/mobile only send T3 RPC commands.

Do not mention repository source paths or test tooling in this user guide.

### `docs/README.md`

Add the Pi provider guide to the provider links.

## Maintainer documentation

Update:

- `docs/internals/providers.md`: six drivers, `pi` row, RPC transport/bridge notes;
- `docs/internals/overview.md`: architecture diagram and driver count/list;
- `docs/internals/glossary.md`: provider entry and links to Pi driver/adapter;
- `docs/user/permission-modes.md`: Pi joins providers without a native Auto equivalent and falls back to Supervised.

Document durable architectural decisions, not this phase checklist. This `project-phases` directory is the requested implementation artifact; do not copy its task lists into internals docs.

## Integration harness

Add a deterministic executable fixture rather than depending on developer credentials. It should behave like `pi --mode rpc` and support:

- version output;
- state/model/commands inventory;
- new/resumed/forked session identity;
- prompt acceptance and streaming text/thinking/tools;
- extension approval and arbitrary input dialogs;
- steering and abort;
- entries and rollback fork;
- clean/unexpected exits.

Use it in a focused server integration test that runs the real `PiRpcConnection`, `PiAdapter`, provider service/reactor, and orchestration ingestion. Wait on runtime receipts and worker drains—never sleeps or polling.

Required scenarios:

1. create T3 thread on Pi and complete a tool-using turn;
2. stop/reap provider session, resume via persisted cursor, complete follow-up with history retained;
3. change cwd/worktree and verify a Pi fork rather than empty session;
4. Supervised approval round trip;
5. third-party extension select/input round trip;
6. model/thinking switch in the same thread;
7. checkpoint rollback invokes Pi conversation rollback and returns a usable session;
8. unexpected Pi exit settles the T3 turn as failed;
9. multiple Pi instances with different homes/environments do not cross state;
10. large model inventory remains bounded to one provider snapshot update.

## Optional real-Pi probe

Add an opt-in test, skipped by default, for maintainers with Pi installed, for example:

```text
T3_PI_RPC_PROBE=1 vp test run apps/server/src/provider/pi/PiRpcCliProbe.test.ts
```

It may verify only:

- `pi --version`;
- RPC startup;
- `get_state`;
- `get_available_models` shape;
- clean shutdown.

It must not send an LLM prompt, mutate Pi's selected model, edit project files, or require a particular provider credential.

## Focused verification commands

Exact workspace filters may differ when files land; use the smallest applicable commands, such as:

```text
vp test run packages/contracts/src/<pi-related-tests>
vp test run apps/server/src/provider/pi/*.test.ts
vp test run apps/server/src/provider/Layers/PiAdapter.test.ts
vp test run apps/server/src/provider/Layers/PiProvider.test.ts
vp test run apps/server/src/provider/Drivers/PiDriver.test.ts
vp test run apps/server/src/textGeneration/PiTextGeneration.test.ts
vp test run apps/web/src/components/settings/<pi-related-tests>
vp test run apps/mobile/src/lib/modelOptions.test.ts
```

Run targeted lint/typecheck for only changed packages. Do not run `vp check`, recursive tests, or repo-wide typecheck unless explicitly requested.

## Real-client verification

Only with explicit user permission:

- use the `test-t3-app` skill against disposable worktree `.t3` state;
- never point a dev server at `~/.t3/userdata`;
- configure the deterministic Pi fixture or a disposable Pi home;
- verify Settings -> provider enable/configuration, model picker, a streamed turn, approval, resume after server/provider restart, and worktree move;
- desktop is covered by web behavior unless Electron-specific packaging of the materialized bridge fails;
- use `test-t3-mobile` for one remote model-selection and approval/input pass.

Capture before/after evidence only if preparing a requested PR. Do not commit PR-only screenshots.

## Security and privacy review

Before completion, verify:

- provider environment values and model API keys never cross the T3 websocket;
- native logs redact image base64 and bounded sensitive dialog content;
- Pi session files remain under Pi's configured storage, not copied into T3 databases;
- extension source is static/versioned and written atomically;
- launch args cannot escape RPC mode or replace T3's session selection;
- no process is killed by pattern;
- remote clients cannot submit raw Pi RPC—only authorized T3 orchestration commands;
- unknown extension tools are gated in non-full-access modes.

## Final surface checklist

State explicitly in the completion report:

- **Entry points:** Settings/add-provider/model picker/permission UI checked; no command-palette or keybinding entry is applicable.
- **Clients:** web and mobile changed; desktop inherits web; marketing is not applicable.
- **Providers:** only the new Pi adapter changes; existing five adapters remain behaviorally unchanged.
- **Contracts:** settings, model metadata, and raw event source updated across server/web/mobile.
- **Reverse states:** enable/disable, add/delete instance, approve/decline, start/stop/resume all work.
- **Connection modes:** local and remote clients route through the environment server; no baked origin.
- **Docs:** user, internals, permission modes, and glossary updated.

## Acceptance criteria

- Deterministic integration tests prove the end-to-end orchestration path.
- Optional real probe confirms compatibility with a contemporary installed Pi without spending model tokens.
- User docs accurately describe retained Pi extensibility and conservative permission semantics.
- No live T3 userdata or unrelated dev server is modified during verification.
