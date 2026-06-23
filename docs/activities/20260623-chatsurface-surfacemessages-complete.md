# chatSurface decomposition — increment 5: SurfaceMessages (COMPLETE)

**Shipped:** v0.79.195 (local VS Code + code-server `development`)
**chatSurface.ts:** 610 → 300 lines · new `src/ui/surfaceMessages.ts` (373)
**chatSurface is now OFF the 400-line exempt list.**

## What moved

The whole `onMessage` webview→host switch (332 lines, ~30 cases) → new
`SurfaceMessages` collaborator with a single `handle(message)` method. This was the
most coupled block in the file — it touched every collaborator and all session state.

## Seam

`SurfaceMessages` gets a wide deps bag: `webview`, `deps`, `post`, `markReady`,
`refreshSessions`, `openSession`, `getController`/`getTerminalSession`/`getFollowHandle`,
and the `sync`/`dialogues`/`handoff`/`changedFiles` collaborators + `hub`.

- The `ready` case's private bits (flip `ready`, send host boot, flush + clear the
  pre-ready `queue`) were pulled into a new `markReady()` on the surface, called via dep.
- `ChatSurface.onMessage` is now a 1-line delegator (`return this.messages.handle(...)`),
  so the `webview.onDidReceiveMessage` wiring is unchanged.
- Like `dialogues`, `messages` is **constructor-body-initialized** (eager deps reads),
  and is created AFTER `dialogues` (it depends on it).

Dead imports dropped from chatSurface: `probeRtk`, `setTaskDone`, `removeGuardrail`,
`clearSessionGuardrails`, `attachmentFromUri`, `writeDroppedFile`, `writePastedImage`,
`SessionStartOptions`/`AgentAdapter` trims — all now live in surfaceMessages.

## The full chatSurface decomposition (1318 → 300)

| increment | collaborator | file | lines out | version |
|---|---|---|---|---|
| 1 | ChangedFilesManager | changedFiles.ts | 1318→1235 | 0.79.190 |
| 2 | BackendHandoff | backendHandoff.ts | →1124 | 0.79.191 |
| 3 | SurfaceSync | surfaceSync.ts | →964 | 0.79.192 |
| 4 | SurfaceDialogues | surfaceDialogues.ts | →610 | 0.79.194 |
| 5 | SurfaceMessages | surfaceMessages.ts | →300 | 0.79.195 |

ChatSurface is now a thin coordinator: owns the session state (controller / terminal /
follow handle), the post-queue + ready handshake, and small helpers
(`refreshSessions`, `buildLangHint`, `detach*`, `sessionDeleted`, `cwd`/`sid`, `dispose`),
wiring five collaborators together. All collaborators are ≤400.

## Verification

- `npx tsc -p ./` — clean
- `check:size` — chatSurface removed from EXEMPT; all source ≤400
- `npm test` — 49/49 · `check:webview` pass
- jsdom harness — no load-time errors
- bundle 138.8 KB, packaged + installed both targets

## Remaining

`src/adapters/openai/session.ts` (841) — the last exempt file. The OpenAISession turn
loop (run / consume stream / compact). Next.
