# chatSurface decomposition — increment 4: SurfaceDialogues

**Shipped:** v0.79.194 (local VS Code + code-server `development`)
**chatSurface.ts:** 964 → 610 lines · new `src/ui/surfaceDialogues.ts` (394)

## What moved

The dialogue lifecycle cluster → new `SurfaceDialogues` collaborator:

- `openDialogue` (the 132-line core: new / resumed, lang-hint + workspace bootstrap
  injection, controller reuse-or-create, meta post, the controller `attach` callback
  with changed-files filter / lastActive capture / panel repaint on tool-end + turn-end)
- `openTerminalDialogue`, `followSession` (read-only mirror), `openSession` (resume)
- `restoreOrStart`, `startDefaultDialogue`
- `restartFromMessage`, `editResend` (branch flows)

Also dropped ~32 lines of orphan doc-comments left from the BackendHandoff extraction.

## Seam

State stays surface-owned. `SurfaceDialogues` gets `getController`/`setController`/
`setTerminalSession`/`setFollowHandle`/`setFollowedSessionId` callbacks plus `post`,
`detachActive`, `buildLangHint`, `onTitleChange`, and the `sync`/`changedFiles`
collaborators. `followSession`/`openTerminalDialogue` capture the handle/terminal in a
local var (instead of re-reading `this.field`) so no getter is needed for them.

**Init in the constructor body, not a field initializer:** the deps bag eagerly reads
parameter properties (`this.deps`/`this.webview`/`this.chatOnly`/`this.onTitleChange`),
which TS assigns only once the constructor body runs — a field initializer would hit
TS2729. (Contrast `changedFiles`/`handoff`/`sync`, whose deps are all lazy arrows.)

The four **public** entry points (`openSession`/`followSession`/`openDialogue`/
`openTerminalDialogue`) are kept as thin delegators on `ChatSurface` — external callers
(commands, chatView, chatPanel, BackendHandoff) are unchanged. The four private flows
(`restoreOrStart`/`startDefaultDialogue`/`restartFromMessage`/`editResend`) had their
in-surface callsites repointed to `this.dialogues.*`.

## Verification

- `npx tsc -p ./` — clean
- `npm test` — 49/49 · `check:webview` + `check:size` pass
- jsdom harness — no load-time errors
- bundle rebuilt (138.4 KB), packaged + installed both targets

## Remaining

chatSurface 610 → under 400 needs `onMessage` (~336, the webview message switch) out —
the last big block and the riskiest (it touches nearly every collaborator). Then
`openai/session.ts` (841).
