# Plan: eliminate slow Symposium startup caused by full transcript scans

## Status

Proposed for implementation by Hugo.

## Summary

Symposium's VS Code extension activates quickly, but its chat surface takes several seconds to become usable and several minutes to finish loading the sessions list on Windows.

The dominant cause is not VSIX size, extension activation, VS Code Speech, or webview parsing. On each webview `ready` event, Symposium launches two independent all-backend session scans. Those scans read and parse complete Claude and Codex transcript files to recover a small amount of metadata. A six-second `Promise.race` stops waiting for one scan but does not cancel it, so both scans continue in the background.

On the measured Windows installation, each scan processes approximately `3.859 GB` of Claude and Codex transcripts. Two simultaneous scans therefore trigger approximately `7.718 GB` of logical reads and extensive string splitting and JSON parsing.

## Measured evidence

Environment:

- VS Code desktop on Windows
- Extension: `sufficit.sufficit-vscode-symposium@2026.722.6`
- Repository: `sufficit/sufficit-vscode-symposium`

Observed timeline:

```text
2026-07-24T12:35:19.686Z extension activation
2026-07-24T12:35:19.885Z webview ready
2026-07-24T12:35:25.962Z first session meta
2026-07-24T12:39:34.368Z sessions list delivered
```

Calculated durations:

| Milestone | Duration |
|---|---:|
| Extension activation to webview `ready` | `199 ms` |
| Webview `ready` to first `meta` | `6.077 s` |
| Webview `ready` to `sessions` | `254.483 s` |

Transcript corpus on the measured Windows profile:

| Backend | Files | Total size | Largest file |
|---|---:|---:|---:|
| Claude | `1778` JSONL files | `2.035 GB` | `128.2 MB` |
| Codex | `96` JSONL files | `1.824 GB` | `131.1 MB` |
| Combined per scan | `1874` files | `3.859 GB` | — |
| Two startup scans | — | approximately `7.718 GB` | — |

Bundle measurements:

```text
out/extension.js          603,903 bytes
out/ui/webview.bundle.js  237,978 bytes
out/ui/webview.css         92,916 bytes
V8 bundle compilation       ~8.5 ms
```

The bundle and webview can be optimized later, but they do not explain a four-minute sessions-list delay.

## Root causes

### 1. Duplicate full scans on webview startup

`src/ui/surfaceMessages.ts` starts both operations when it receives `ready`:

```ts
void this.d.refreshSessions();
void this.d.dialogues.restoreOrStart();
```

Both paths call the shared all-backend `listSessions()` dependency independently.

`src/ui/surfaceDialogues.ts` uses:

```ts
const sessions = await Promise.race([
    this.d.deps.listSessions().catch(() => [] as SessionInfo[]),
    new Promise<SessionInfo[]>((resolve) => setTimeout(() => resolve([]), 6000)),
]);
```

The timeout does not cancel the scan. It only abandons its result after six seconds. This explains the approximately six-second delay before fallback startup and leaves an orphan scan consuming resources.

### 2. Claude reads complete transcripts to inspect the first 30 lines

`src/adapters/claude/transcript.ts` reads the entire file:

```ts
content = await fs.promises.readFile(file, "utf8");
```

It then uses only:

```ts
content.split("\n").slice(0, 30)
```

Large immutable transcripts are fully allocated, decoded, split, and parsed on every refresh.

### 3. Codex reads and parses every line of every transcript

`src/adapters/codex/transcript.ts` reads each complete JSONL file and iterates all lines to recover metadata. Large transcripts are repeatedly processed even when their path, size, and modification time have not changed.

### 4. OpenAI session listing synchronously parses message history

`src/adapters/openai/store.ts` uses:

```ts
JSON.parse(fs.readFileSync(storePath(backend, id), "utf8"))
```

The stored object includes `messages: ChatMsg[]`, although session listing needs only metadata. This blocks the extension host and scales with conversation length.

### 5. No persistent session metadata index

Every refresh re-discovers and re-parses historical files. There is no reusable index keyed by file identity such as:

```text
backend
path
size
mtimeMs
sessionId
title
cwd
model
lineageId
parentId
updatedAt
```

### 6. Full scans have many triggers

The same expensive path can run during:

- webview startup;
- last-session restoration;
- manual refresh;
- live-session status changes;
- session creation or completion;
- panel creation;
- session commands;
- backend handoff.

### 7. Secondary duplicated startup work

One measured startup produced:

```text
account updates: 3
Sufficit AI health checks: 3
Tailnet checks: 3
```

Authentication restoration fires change events that repeat health, profile, sync, and Tailnet work. This is secondary to transcript scanning but should be deduplicated.

## Goals

1. Make the chat surface usable without waiting for an all-history scan.
2. Restore the last session without listing every session.
3. Avoid reading unchanged transcripts more than once.
4. Avoid loading complete transcripts when only metadata is needed.
5. Share one in-flight scan across all consumers.
6. Ensure timed-out or superseded work is cancellable or harmless.
7. Keep the extension host responsive while indexing.
8. Preserve session ordering, nesting, archived/pinned state, lineage, and live status.

## Non-goals

- Changing voice or dictation behavior.
- Changing transcript formats owned by Claude, Codex, or Copilot.
- Deleting or rewriting existing user transcripts.
- Making remote bridge startup part of the critical rendering path.
- Redesigning the chat UI.

## Proposed architecture

### `SessionIndex` service

Introduce one extension-scoped service responsible for session discovery and metadata caching.

Suggested interface:

```ts
interface SessionIndex {
    list(options?: { force?: boolean; signal?: AbortSignal }): Promise<SessionInfo[]>;
    get(backend: string, sessionId: string): Promise<SessionInfo | undefined>;
    invalidate(change?: { backend?: string; path?: string; sessionId?: string }): void;
    refreshInBackground(): void;
    dispose(): void;
}
```

Responsibilities:

- Keep one in-memory snapshot.
- Persist metadata under `context.globalStorageUri`.
- Key filesystem entries by `path + size + mtimeMs`.
- Reuse metadata for unchanged files.
- Parse only new or modified transcripts.
- Deduplicate concurrent `list()` calls with one in-flight promise.
- Return the cached snapshot immediately, then refresh incrementally.
- Emit a change event only when the effective session list changes.
- Apply bounded concurrency for filesystem reads.

Suggested persisted record:

```ts
interface IndexedSessionRecord {
    schemaVersion: number;
    backend: string;
    path?: string;
    size?: number;
    mtimeMs?: number;
    sessionId: string;
    title: string;
    cwd?: string;
    model?: string;
    lineageId?: string;
    parentId?: string;
    updatedAt?: string;
    continuationBlockedReason?: string;
}
```

The index must be disposable and versioned so incompatible schema changes can trigger a safe rebuild.

## Implementation phases

### Phase 1: instrumentation and regression fixtures

Add structured timing around:

```text
extension activation
webview HTML assignment
webview ready
session index cache load
per-backend discovery
metadata parsing
last-session restore
sessions postMessage
```

Record:

- elapsed milliseconds;
- files visited;
- bytes read;
- cache hits and misses;
- concurrent callers;
- cancellation or timeout counts.

Add test fixtures with large synthetic JSONL files and thousands of session entries without committing giant binaries.

### Phase 2: remove duplicate startup scans

Change the startup flow so one operation owns discovery.

Required behavior:

1. Load the persisted index snapshot.
2. Post the cached sessions list immediately.
3. Restore the last active session through `SessionIndex.get(backend, sessionId)`.
4. Run one background refresh.
5. Post an updated list only if discovery changes it.

Remove the uncancelled `Promise.race` pattern. If a timeout remains, pair it with cancellation or allow the underlying work to be shared rather than abandoned.

### Phase 3: direct last-session lookup

Restoration should not call `listSessions()`.

Resolution order:

1. Live runtime session.
2. Indexed metadata by `(backend, sessionId)`.
3. Backend-specific direct path lookup where possible.
4. New dialogue fallback.

The composer should become available immediately after cached metadata is resolved. A background index refresh must not replace a valid restored session with a new dialogue.

### Phase 4: bounded Claude metadata reader

Replace full-file reads with a bounded line reader.

Requirements:

- Read only enough bytes to obtain the first 30 non-empty/required lines.
- Stop as soon as `title`, `cwd`, `gitBranch`, and `originSessionId` are resolved or the line limit is reached.
- Handle UTF-8 boundaries safely.
- Set a maximum metadata probe size.
- Never allocate a string proportional to a 100+ MB transcript during listing.

Possible implementation:

- `fs.createReadStream()` plus `readline`;
- custom buffered reads from the file start;
- cache by `path + size + mtimeMs`.

### Phase 5: bounded Codex metadata reader

Codex needs metadata that may not all occur in the first line. Avoid a complete parse during normal listing.

Options, in priority order:

1. Persist metadata when Symposium creates or observes a session.
2. Parse a bounded prefix for `session_meta`, title, model, parent, and lineage.
3. Read a bounded suffix only for fields that genuinely require recent events.
4. Fall back to a one-time full scan only for an uncached legacy transcript, then persist the result.

The one-time fallback must use bounded concurrency and must not block initial UI rendering.

### Phase 6: separate OpenAI metadata from messages

Do not parse `messages` to list sessions.

Options:

- store `<session>.meta.json` separately from `<session>.json`;
- maintain an index updated by `writeStored()`;
- redesign the store format with `{ meta, messages }` while providing migration.

All listing operations must be asynchronous or return indexed data. Existing files must remain readable.

### Phase 7: incremental invalidation

Invalidate only affected records when:

- Symposium writes a session;
- a live session receives persisted metadata;
- a session is renamed, archived, pinned, deleted, branched, or nested;
- a watched transcript path changes;
- manual refresh is requested.

A manual refresh may rescan directory entries, but unchanged files must remain cache hits and must not be re-read.

Avoid broad recursive watchers on huge home-directory trees. Prefer targeted directories, debounced events, and periodic reconciliation.

### Phase 8: deduplicate account and network startup work

Add single-flight/debounce behavior for:

- `SufficitAuth.getProfile(true)`;
- Sufficit AI availability/model discovery;
- hub auto-sync;
- Tailnet checks;
- Codex Sufficit MCP synchronization.

Authentication restoration should publish one stable state transition rather than multiple equivalent `onDidChange` cascades.

### Phase 9: bundle and webview cleanup

After session discovery is fixed:

- re-enable tree-shaking safely;
- isolate command-only features behind dynamic imports;
- lazy-load configuration panel code and QR generation;
- avoid importing all backend session implementations before they are used;
- consider loading webview JS/CSS as resources instead of constructing one large inline HTML string;
- keep voice, bridge, and remote-access code outside the initial chat path when disabled.

This phase is lower priority because measured extension-to-webview readiness is already approximately `199 ms`.

## Concurrency and cancellation rules

1. Only one discovery per backend may run at a time.
2. Multiple callers await the same promise.
3. A force refresh supersedes or joins the current refresh; it must not create an uncontrolled duplicate.
4. Surface disposal must stop delivery to that surface but should not necessarily cancel a shared refresh needed by another surface.
5. Expensive legacy parsing must use bounded concurrency.
6. Results from an older generation must never overwrite a newer snapshot.
7. Failure in one backend must not discard cached sessions from other backends.

## Correctness requirements

The optimized implementation must preserve:

- newest-first ordering;
- custom titles;
- archived state;
- pinned ordering;
- parent/subagent nesting;
- lineage information;
- backend display names;
- live `working`/`idle` status;
- continuation restrictions;
- permanent-delete behavior;
- custom OpenAI-compatible adapters;
- Windows, WSL, Linux, and code-server compatibility.

## Test plan

### Unit tests

- Concurrent callers share one scan.
- Timeout/surface disposal does not leave duplicate scans.
- Unchanged `(path, size, mtimeMs)` entries are cache hits.
- Modified files are reparsed.
- Deleted files are removed from the index.
- Corrupt index files trigger safe rebuilds.
- Claude parser stops after the bounded prefix.
- Codex parser uses cached metadata and bounded fallback.
- OpenAI listing does not parse message history.
- Stale scan generations cannot overwrite newer results.

### Integration tests

Generate temporary corpora containing:

- thousands of small files;
- sparse files larger than `100 MB`;
- malformed JSONL lines;
- legacy Codex sessions;
- Claude subagent directories;
- archived, pinned, nested, and deleted sessions.

Assert both result correctness and bytes-read limits.

### Manual validation

Test separately on:

- VS Code desktop Windows;
- local Linux;
- WSL remote workspace;
- code-server;
- empty profile;
- profile containing several gigabytes of transcripts;
- signed-in and signed-out Sufficit states;
- bridge enabled and disabled.

Use `Developer: Show Running Extensions`, Symposium output timing, CPU usage, memory usage, and filesystem read metrics.

## Acceptance criteria

For a warm launch with a valid index:

- extension activation to webview `ready`: `< 500 ms`;
- webview `ready` to usable composer/session meta: `< 1 s`;
- cached sessions list visible: `< 1 s`;
- no complete historical transcript scan on the critical path;
- no duplicate per-backend scan;
- unchanged large transcripts contribute zero content bytes read;
- extension host remains responsive.

For a cold launch with no index:

- composer/session fallback available: `< 1.5 s`;
- session discovery runs in the background;
- first useful partial or cached list appears without waiting for all backends;
- each transcript is parsed at most once;
- memory remains bounded and does not scale with the sum of transcript sizes;
- subsequent launch meets warm-launch targets.

For the measured Windows corpus:

- session list should not take `254 s`;
- startup should not logically read approximately `7.718 GB`;
- no individual `128 MB` or `131 MB` transcript should be fully allocated merely to list sessions.

## Suggested delivery sequence

1. Add timing/bytes-read instrumentation and tests.
2. Implement extension-scoped single-flight `SessionIndex`.
3. Use cached index for immediate list rendering.
4. Restore last session directly by ID.
5. Implement bounded Claude metadata parsing.
6. Implement cached/bounded Codex metadata parsing.
7. Split OpenAI metadata from message storage.
8. Add incremental invalidation and background reconciliation.
9. Deduplicate auth, health, sync, and Tailnet startup work.
10. Optimize bundle imports and tree-shaking.

## Risks and mitigations

### Stale metadata

Mitigation: validate indexed records with `size + mtimeMs`, expose manual refresh, and reconcile in the background.

### Transcript formats change upstream

Mitigation: version backend parsers, retain tolerant fallback parsing, and record parser failures without dropping prior cached metadata.

### Index corruption

Mitigation: atomic writes through a temporary file plus rename, schema versioning, and safe rebuild.

### Very large first cold scan

Mitigation: background execution, bounded concurrency, partial results, persisted progress, and no dependency between composer readiness and scan completion.

### Multiple webviews or panels

Mitigation: keep `SessionIndex` extension-scoped rather than surface-scoped and multicast snapshot updates.

## Definition of done

- All acceptance criteria pass.
- Existing tests pass.
- New performance regression tests pass.
- Manual validation completed on Windows and WSL.
- Startup logs demonstrate one shared scan, cache hit rates, and bounded bytes read.
- Documentation describes index location, invalidation, and troubleshooting.
- No change introduces or depends on visible `dictation-*.txt` tabs.
