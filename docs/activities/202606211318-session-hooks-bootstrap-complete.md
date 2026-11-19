# Activity — session-start hook and per-workspace bootstrap

> Status: **complete**; audited against the source on 2026-08-01.
> Repo: `sufficit-vscode-symposium`.

## Goal

Hooks on session lifecycle events. First concrete hook: **on session start**, show
a per-workspace **bootstrap** (curated Sufficit knowledge) on the new-session
screen — before the first message — as a clickable link to the source file, and
inject it as context ahead of the user's first message.

## Decision: TEXT (plain), not reference

Chosen plain-text injection from a local synced doc, **not** a memory-id +
tool reference. Why:

- **Backend-agnostic.** Claude/Codex/Copilot CLIs have no Sufficit memory tool
  (only the API backend does); a reference would silently no-op on 3 of 4
  backends. Plain text injected before msg 1 works on all.
- **No tool/auth dependency.** A reference needs the agent to call
  `memory_get_observations` — same path that just hit 401s. Text is deterministic.
- **The link needs a real target.** The sync already materializes memory→local
  files, so a `bootstrap` resource gives the "click to read" link a real file.

Reference would only win for huge/dynamic payloads; a workspace bootstrap is
small + stable.

## Implemented design

### Bootstrap = a synced resource kind, scoped by workspace

- New `ResourceKind` `"bootstrap"` → `repo/bootstrap/<name>.md`, synced through
  the existing hub push/pull (`type: agent-bootstrap`, tag `kind:bootstrap`).
- `<name>` = the **workspace key** = the workspace folder basename (e.g.
  `sufficit-standard`). Zero-config: a new session in folder `X` looks for
  `repo/bootstrap/<basename(X)>.md`. Optional `default.md` fallback for "any
  workspace".
- The bootstrap content is curated in Sufficit memory and synced down; locally
  it is a plain `.md` the user can open/edit.

### On session start (the hook)

In `ChatSurface.openDialogue`, for a **new** (non-resumed) session only:
1. Resolve `readWorkspaceBootstrap(cwd)` → `{ text, path, name }`.
2. If present: set `options.bootstrap = text` before creating the controller.
3. Post `bootstrapLink: { path, name }` in the `meta` message.

### Injection (before the first message)

`SessionStartOptions.bootstrap` → threaded into `buildOutboundPrompt` like
`seedHistory`: prepended **once** before the first user turn (and before
seedHistory), as a marked context block. Role-aware backends get it as a
`developer` preamble; CLIs get it prepended to the text. One-shot
(`bootstrapInjected`).

### UI (new-session / empty screen)

`#emptyState` shows a "📎 Workspace bootstrap — click to read" link when
`meta.bootstrapLink` is set; clicking posts `open-file { path }` (existing
handler) to open the file.

## Edits

1. `config/root.ts` — `ResourceKind += "bootstrap"`, `KIND_DIR.bootstrap`,
   `readWorkspaceBootstrap(cwd)` + `workspaceKey(cwd)`.
2. `sync/sync.ts` — `TYPE_OF.bootstrap = "agent-bootstrap"` + reverse.
3. `adapters/types.ts` — `SessionStartOptions.bootstrap?: string`.
4. `ui/outboundPrompt.ts` — `bootstrap?` + `bootstrapInjected`, prepend once.
5. `ui/chatController.ts` — pass `bootstrap`, track injected state.
6. `ui/chatSurface.ts` — resolve on new session, set option, post `bootstrapLink`.
7. `ui/chatHtml.ts` + `ui/chatClient.ts` — render the empty-state link.

## Future hooks (same pattern)

`resolveSessionStartContext(cwd)` is the first lifecycle hook. Later events
(pre-send, turn-end, session-open) can plug into the same surface. Out of scope
for this slice.

## Audit evidence (2026-08-01)

- `src/config/root.ts` defines the `bootstrap` resource, workspace-key lookup
  and `default.md` fallback.
- `src/sync/sync.ts` maps the resource to `agent-bootstrap`.
- `src/ui/surfaceDialogues.ts` resolves new-session bootstrap content and posts
  its file link; the webview renders and opens that link.
- `src/ui/outboundPrompt.ts` injects the content once, and
  `src/test/outboundPrompt.test.ts` covers its ordering and one-shot behavior.
- The implementation originally shipped in commit `4c7d532`.
