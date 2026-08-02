# Activity — `read_session` reads the live runtime

**Date:** 2026-06-23
**Session:** 0ff7e86f-75c2-4639-b245-563dd42ddc23
**Status:** complete; audited against the source on 2026-08-01.

## Problem

The `read_session` AI tool (`src/adapters/aiTools/run.ts`) recovers a session's
full transcript so an agent can re-read its own context. It calls
`readSession(id)` (`src/sessionReader.ts`), which only reads **disk**:

1. Ledger — `~/.symposium/ledger/<id>/messages.jsonl`
2. Store — `~/.symposium/sessions/<backend>/<id>.json`
3. CLI transcripts — `~/.claude/projects`, `~/.codex/sessions`

When an agent calls `read_session` for a **live session whose messages have not
yet been flushed to the ledger** (brand-new session, mid-turn, or backend that
buffers before persisting), the tool returns an empty transcript. The agent then
"loses the thread" — it believes there is no prior context.

The freshest, always-correct copy of a live conversation is in the running
`ChatController.stream.messages`, exposed via `controller.transcriptMessages()`.
The tool layer cannot import the runtime directly (layering rule), so it never
sees this.

## Goal

`read_session` returns the live transcript for any **running** session, falling
back to disk for sessions with no live controller. No regression for disk-only
sessions.

## Implemented design

Mirror the existing late-bound singleton pattern used for subagents
(`setSubagentHost` / `getSubagentHost` in `aiTools/types.ts`). The low-level tool
layer stays runtime-free; `extension.ts` injects a reader backed by `LiveSessions`.

### 1. `aiTools/types.ts` — new late-bound reader

```ts
export interface LiveTranscriptReader {
    /** Live transcript for a running session, or undefined if none is live. */
    read(sessionId: string): { backend?: string; title?: string;
        messages: { role: string; text: string }[] } | undefined;
}
let liveTranscriptReader: LiveTranscriptReader | undefined;
export function setLiveTranscriptReader(r: LiveTranscriptReader | undefined): void { … }
export function getLiveTranscriptReader(): LiveTranscriptReader | undefined { … }
```

### 2. `aiTools/run.ts` — `read_session` prefers the MORE COMPLETE source

- Resolve `id` (arg or `ctx.sessionId`).
- Read BOTH: `readSession(id)` (disk) and `getLiveTranscriptReader()?.read(id)`.
- Use live ONLY when `live.messages.length > disk.count` — i.e. it has unflushed
  messages the ledger doesn't have yet. Otherwise use disk.
- **Why not live-first:** a RESUMED session's live controller holds only
  post-resume messages; live-first would shadow the complete ledger history and
  return just the last couple of turns (regression seen in v0.79.214–216).

### 3. `sessionReader.ts` — add `"live"` to the `SessionDump.source` union

### 4. `LiveSessions` (`sessions/runtime.ts`) — expose `readTranscript`

```ts
readTranscript(sessionId: string) {
    const c = this.findBySessionId(sessionId);
    if (!c) return undefined;
    return { backend: c.backend, title: c.title, messages: c.transcriptMessages() };
}
```

### 5. `extension.ts` — wire it

```ts
setLiveTranscriptReader({ read: (id) => runtime.readTranscript(id) });
context.subscriptions.push({ dispose: () => setLiveTranscriptReader(undefined) });
```

## Out of scope

- Synced/remote sessions that were never run on this machine (e.g. only
  task-anchors in shared memory) legitimately have no transcript here. The
  session list / memory tasks are the recovery path for those, not read_session.
- Subagent visual distinction in the sessions list (tracked separately).

## Verification

- `npm run compile` clean (tsc + webview).
- Manual: open a live session, agent calls `read_session` → returns the running
  transcript even before a ledger flush. Disk-only sessions still read from disk.

## Audit evidence (2026-08-01)

- `src/adapters/aiTools/types.ts` owns the late-bound `LiveTranscriptReader`.
- `src/adapters/aiTools/localRun.ts` compares live and disk counts and keeps the
  more complete transcript, including the resumed-session safeguard.
- `src/sessions/runtime.ts` exposes `readTranscript`, and `src/extension.ts`
  registers and disposes the reader.
- `src/sessionReader.ts` includes `live` in `SessionDump.source`.
- The implementation originally shipped in commit `8192f30`.
