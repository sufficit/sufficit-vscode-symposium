# Activity — persistent render log and exact visual reload

**Date:** 2026-06-23
**Status:** persistence and replay implemented; remaining deletion cleanup and
regression coverage extracted on 2026-08-01 to
[`PLAN-session-local-artifact-cleanup.md`](../PLAN-session-local-artifact-cleanup.md).

## Problem

Reopening a stored session rebuilds the view from `adapter.history()`, which
reconstructs only user/assistant **text** bubbles. Everything else the user saw
is lost: tool rows + diffs, status notices, panels, thinking blocks, inline
comments/annotations — all the rich render output. The user wants a session to
reload its **exact visual** at any time ("tudo mesmo, até os itens gráficos").

The complete visual already exists in memory as `RenderStream.log` — the exact
stream of render messages the webview consumes (and replays on view switch via
`bindSink`). It is just never persisted, so a disposed/reopened controller (new
process, or session opened from disk) starts with an empty log.

## Delivered goal

Persist the render log per session and replay it on reopen, so the conversation
view is byte-for-byte what the user last saw, including all non-text elements.
Fall back to the old `adapter.history()` reconstruction only when no render log
exists (older sessions).

## Implemented design

### 1. `src/renderLog.ts` (new) — append-only render persistence
Stored next to the ledger: `~/.symposium/ledger/<id>/render.jsonl`.
- `appendRender(sessionId, msg)` — one JSON line per render message. Per-line
  cap (~1 MB) to keep a giant diff from bloating the file; oversized payloads are
  truncated with a marker.
- `readRender(sessionId): unknown[]`
- `hasRender(sessionId): boolean`
- `removeRender(sessionId)` — called on permanent session delete.

### 2. `RenderStream` — persist hook + seed
- Constructor takes optional `onPersist?(msg)`. `emit()` calls it after buffering
  and fan-out, so every visible render message is persisted.
- `seed(messages)` pushes prior messages into the log WITHOUT persisting or
  fanning out — used to preload a resumed session before the sink binds.

### 3. `ChatController`
- Wire `onPersist` with a flush keyed on `sessionId`. Brand-new sessions get
  their id only after the first turn, so persist lazily: keep `persistedCount`,
  and on each emit (once `sessionId` is known) append `log[persistedCount..]`,
  advancing the counter. This flushes anything buffered before the id arrived.
- `seedRenderLog()`: when a resumed session has a render log, `stream.seed(...)`
  it and set `persistedCount` to its length (don't re-persist).
- `loadHistory` becomes the fallback: skipped when a render log was seeded.

### 4. Resume flow (`surfaceDialogues.openDialogue`)
- Right after `runtime.create(...)` for a `resumeSessionId` with a render log,
  call `controller.seedRenderLog()` BEFORE `controller.attach(...)` so the
  replay shows the exact visual. Skip `loadHistory(info)` in that case.

## Out of scope
- Older sessions with no render log keep the lossy `adapter.history()` view.
- Cross-machine sync of the render log (local-only, like the ledger).

## Audit evidence (2026-08-01)

- `src/renderLog.ts` appends, reads and detects `render.jsonl` with line-size
  protection.
- `src/ui/renderStream.ts` persists emitted messages and seeds restored ones
  without a second write.
- `src/ui/controllerPersist.ts` flushes messages buffered before the provider
  assigns a session id and restores the saved queue with the render stream.
- `src/ui/surfaceDialogues.ts` seeds the visual before attaching the sink and
  falls back to adapter history when no render log exists.
- The implementation originally shipped in commit `1493a35`.

## Gap found by the audit

`removeRender(sessionId)` exists but has no caller. OpenAI happens to remove the
whole Symposium ledger from inside its adapter, while Claude, Codex and Copilot
delete only provider-owned artifacts. That leaves a backend-dependent privacy
and storage gap in the common permanent-delete operation. Focused persistence,
reopen and delete regression tests are also absent. The remaining plan linked
above centralizes that work instead of leaving it in this completed activity.
