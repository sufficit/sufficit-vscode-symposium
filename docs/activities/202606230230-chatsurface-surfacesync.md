# chatSurface decomposition — increment 3: SurfaceSync

**Shipped:** v0.79.192 (local VS Code + code-server `development`)
**chatSurface.ts:** 1124 → 964 lines

## What moved

Extracted the per-session "push-to-panel" refreshers + two related actions out of
`ChatSurface` into a new `SurfaceSync` collaborator (`src/ui/surfaceSync.ts`, 159 lines):

- `refreshTasks` (Sufficit-memory tasks → Tasks panel, with `.vscode/symposium.tasks.json` mirror)
- `refreshGuardrails` (session guardrails → panel)
- `openInspectView` (compact model context / last request → read-only tab)
- `attachBrowserPage` (VS Code `open_browser_page` snapshot → context chip)
- `postCommands` (backend slash commands + symposium builtins → autocomplete)
- `refreshModels` (async remote model discovery → picker repopulate)
- `pushAccount` (Sufficit account → sessions-pane footer)
- `taskMirrorFile` (private helper)

## Seam

`SurfaceSync` takes a lazy-getter deps bag (`SurfaceSyncDeps`) — all `() =>` arrows, so the
`private readonly sync = new SurfaceSync({...})` field initializer never eagerly reads sibling
fields (avoids TS2729, same pattern as `BackendHandoff`/`ChangedFilesManager`).

`SurfaceSync` owns its **own** `HubClient` (it was the only remaining consumer of those refresh
paths). `ChatSurface` keeps a separate `HubClient` for its onMessage task/guardrail *mutations*
(`setTaskDone`/`removeGuardrail`/`clearSessionGuardrails`). `HubClient` is a stateless config
reader, so two instances cost nothing.

`refreshSessions` (public, called externally) and `buildLangHint` (reads `this.loggedIn`) were
intentionally left in `ChatSurface`. `loggedIn` stays surface-owned; `SurfaceSync.pushAccount`
writes it back via the `setLoggedIn` dep.

21 callsites rewired `this.X(` → `this.sync.X(`.

## Verification

- `npx tsc -p ./` — clean
- `npm test` — 49/49 pass; `check:webview` (node --check bundle) + `check:size` pass
- jsdom harness — no load-time errors
- esbuild bundle rebuilt (137 KB), packaged + installed both targets

## Remaining (god-object, still size-exempt)

chatSurface 964 → under 400 needs the riskier core out: `onMessage` (~336, the message switch)
and the dialogue lifecycle (`openDialogue`/`openTerminalDialogue`/`restoreOrStart`/
`startDefaultDialogue`/`restartFromMessage`/`editResend`). Then `openai/session.ts` (841).
