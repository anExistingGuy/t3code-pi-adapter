# Phase 6: Web, desktop, and mobile surfaces

## Outcome

Users can configure, recognize, and select Pi on every applicable T3 surface. All behavior is driven by the existing server contracts/snapshots; no client talks to Pi directly.

## Web and desktop

Desktop wraps the web app, so provider UI changes belong in `apps/web`. No new Electron IPC is needed.

### Settings metadata

Update `apps/web/src/components/settings/providerDriverMeta.ts`:

- import `PiSettings`;
- add a definition `{ value:"pi", label:"Pi", icon:PiIcon, settingsSchema:PiSettings }`;
- no Early Access badge by default.

The generic `ProviderSettingsForm` will render binary path, Pi home, and launch args from schema annotations. Verify both the existing default-instance card and `AddProviderInstanceDialog` wizard; do not build a Pi-only form.

### Provider/model picker

Update `apps/web/src/session-logic.ts` `PROVIDER_OPTIONS` with an available Pi entry. A temporary `pickerSidebarBadge:"new"` is a product choice; omit unless requested.

Update hardcoded legacy migration lists in `apps/web/src/composerDraftStore.ts` only where Pi must participate in newly persisted per-provider options. Distinguish two cases:

- old kind-keyed migration arrays are historical and do not need Pi if no old Pi data could exist;
- current iteration over supported built-ins must include Pi so `thinkingLevel` selections persist.

Add tests that make this distinction explicit instead of mechanically adding Pi to every old array.

Existing instance-aware code in `apps/web/src/providerInstances.ts` should derive Pi labels/default models from `PROVIDER_DISPLAY_NAMES` and live snapshots. Add tests rather than adding Pi special cases.

### Icon

Add a Pi brand icon to `apps/web/src/components/Icons.tsx` (or the existing icon module) using the official Pi SVG with a monochrome/current-color treatment compatible with light/dark themes. Do not fetch the logo at runtime.

Map it in:

- `apps/web/src/components/chat/providerIconUtils.ts`;
- provider settings metadata.

`ProviderInstanceIcon` will automatically add instance initials/accent badges for multiple Pi instances.

### Other web checks

Search specifically for closed built-in arrays/maps after adding the known files. Expected checks include:

- provider model defaults/display names;
- composer draft persistence;
- provider update labels (should be generic already);
- add-provider wizard;
- model picker rail.

Do not add Pi to the Usage page's Codex/Claude activity importer; that page reads provider-specific local usage databases and Pi has no corresponding integration in this scope.

## Mobile

Mobile receives provider snapshots through shared client runtime; no mobile provider settings editor is required unless it already supports editing provider instances.

Update `apps/mobile/src/components/ProviderIcon.tsx` with an explicit `provider === "pi"` branch using the same official glyph. Unknown drivers currently fall back to the OpenAI/Codex glyph, so omitting this would visibly misbrand Pi.

Update `apps/mobile/src/lib/modelOptions.ts` provider label fallback so driver `pi` displays `Pi` when no instance display name is present. Prefer a shared contracts display-name helper if introducing one is smaller than another hardcoded branch.

`apps/mobile/src/features/threads/ThreadSettingsSheet.tsx` uses `PRIMARY_PROVIDER_DRIVERS` only to decide initial expansion. Add Pi if product wants everyday built-in harnesses expanded; recommended initial behavior is to add it because Pi is a first-class local harness, not a giant remote model catalog. Pi itself may expose many models, so verify performance with a realistic inventory before finalizing. Provider sections remain collapsible.

No Pi interaction-mode toggle should appear because the server snapshot has `showInteractionModeToggle:false`.

## Command/skill behavior

Provider-discovered Pi skills and commands flow through snapshot contracts. Verify existing composer skill search and slash command UI consume them. If current UI only handles provider-specific command shapes, make the smallest generic fix and cover both web and mobile where applicable.

Do not expose Pi TUI-only commands that RPC does not report.

## Performance constraints

Pi may expose hundreds of models across many upstream providers:

- preserve existing virtualized model lists;
- do not create one websocket subscription per model;
- memoize grouping through existing selectors;
- use stable keys `${instanceId}:${model.slug}`;
- avoid animated rows that continuously repaint;
- do not embed full Pi model metadata beyond `ServerProviderModel` in client state.

Test with duplicate model IDs across different Pi upstream providers; full slugs must keep them distinct.

## Tests

Focused web tests:

- provider definition contains Pi and derives the expected form fields/order;
- add-provider defaults use driver `pi` and no hardcoded model;
- provider icon map resolves Pi;
- default/custom Pi instances have distinct labels/badges;
- model picker groups nested Pi slugs without collision;
- `thinkingLevel` selection persists in the current draft representation;
- Pi's interaction-mode toggle remains hidden.

Focused mobile tests:

- Pi provider label is `Pi`;
- model options preserve provider/model slugs and capabilities;
- Pi icon branch is selected;
- initial section expansion behavior matches the chosen policy.

Integrated browser/simulator verification is deferred to phase 7 and requires explicit user permission under repository rules.

## Acceptance criteria

- Web and desktop can enable/configure default or additional Pi instances and select any discovered Pi model.
- Mobile can recognize and select the same models remotely.
- Pi never renders with the Codex icon.
- Large multi-provider Pi model inventories remain virtualized and responsive.
- No client needs Pi installed locally; only the connected environment/server does.
