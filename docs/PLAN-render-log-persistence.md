# PLAN — persist the full render log (exact visual reload)

**Date:** 2026-06-23
**Status:** in progress

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

## Goal

Persist the render log per session and replay it on reopen, so the conversation
view is byte-for-byte what the user last saw, including all non-text elements.
Fall back to the old `adapter.history()` reconstruction only when no render log
exists (older sessions).

## Design

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

### 5. Cleanup
- `removeRender(sessionId)` wherever the ledger/session is permanently deleted.

## Out of scope
- Older sessions with no render log keep the lossy `adapter.history()` view.
- Cross-machine sync of the render log (local-only, like the ledger).

## Verification
- `npm run lint`, `npm run compile`, `node --test` green.
- Manual: run a tool-heavy turn, reload window, reopen the session → tool rows,
  diffs, status notices and panels reappear exactly (not just text bubbles).
