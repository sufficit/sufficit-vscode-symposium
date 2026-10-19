# AHP async persistence

## Runtime contract

`AhpPersistence.load()`, `save()`, `flush()` and `dispose()` are asynchronous. `save()` captures a runtime snapshot immediately, queues it, and resolves only after its batch has been serialized and atomically installed. Saves captured in the same pending batch are coalesced to the newest complete state. Callers that intentionally persist in the background (for example `maybeSave`) handle the returned rejection; shutdown uses `dispose(runtime)` to save the final snapshot and drain the queue.

Disk reads/writes and shared-file-lock waiting use promises. The lock heartbeats its owner record while held, recovers abandoned owners, and waits without `Atomics.wait`; the temp-file-plus-rename transaction and cross-host session merge remain serialized. Existing validation, size limits, compaction, redaction and corrupt/incompatible-state quarantine are preserved. Activation awaits load before wiring the restored AHP runtime. The VS Code disposable callback starts async disposal and reports any failure to the extension log.

`JsonSessionRepository` keeps its in-memory view synchronous, while mutations return promises for durable completion. Its write queue coalesces pending provider updates and applies each read/merge/write under the same non-blocking cross-process lock. `SessionIndex` awaits writes during scan and forget, and its async disposal flushes queued work. The initial repository load remains synchronous because construction must seed the current synchronous `listCached()` API before its first consumer.

## Size, frequency and fail-closed policy

- **Debounce/coalescing.** `save()` still captures the runtime reference immediately, but the write starts after `saveDebounceMs` (default 150 ms). Every caller in the window resolves with the single newest write. `flush()`/`dispose()` skip the wait. `lastSavedSequence` only advances after a successful rename; failed batches reject all their callers and `maybeSave()` retries them.
- **Incremental serialization.** Channel states are immutable reducer outputs, so redacted JSON and byte size are memoized per object identity (`persistenceCache.ts`). A save re-stringifies only chats that changed; first-time states are warmed with a `setImmediate` yield every 512 KiB.
- **Off-thread parse.** Files >= 1 MiB are parsed in a `worker_threads` worker (`jsonParseWorker.ts`); the buffer is transferred, not copied. The same path serves `load()` and the cross-process merge read.
- **Disk-state cache.** The merge read is reused when `mtime`, `size` and `ino` of `state.json` match what this process last wrote/read.
- **Reconnect-cache bounding.** The target is 25% of `maxBytes`. Order: (1) trim retained actions, (2) keep all sessions and turns but shorten string leaves of tool-call payloads and reasoning to 1,024 then 256 characters (head + tail with an explicit `…[truncated N chars]…` marker; surrogate pairs are never split), (3) only if still over the hard limit, the previous historical-turn compactor. The target is an optimization: if it cannot be reached the smallest valid candidate under `maxBytes` is written. `load()` no longer drops turns; compaction happens on save only.
- **Fail closed.** `mergePersisted` no longer falls back to the local payload on arbitrary errors. Only a missing file proceeds; syntactically invalid JSON is quarantined (`state.corrupt.*`) and then replaced; every other failure (size/session limits, validation, I/O) rejects the save and leaves the on-disk state untouched, so foreign sessions cannot be lost.
- **Codex metadata.** `readCodexMeta` is cached by `mtime`+`size` (the discovery stat is passed down, so the metadata cache does not stat the same file again). The earlier `updatedAt === mtime` shortcut in `listCodexSessions` was removed because it ignored size. Unchanged transcripts are not read again; changed ones use bounded prefix/tail reads (the prefix/tail readers still open/stat their file handles).

## Real-state diagnosis (read-only, aggregate)

`node scripts/diagnose-ahp-state.cjs <state.json>` prints only counts and sizes. On the author's real 20,527,971-byte state (not modified): 289 sessions, 579 snapshots; chat snapshots = 19,186,026 B (93%), session/other snapshots 188 KB, retained actions 2,653 / 1,051,180 B. 277 turns in total (max 1 per chat); `responseParts` = 18,928,784 B of the turn bytes, i.e. the size is tool-call/response payload text, not turn count or the action log. Reading took 24.5 ms and `JSON.parse` 39.3 ms synchronously in a standalone script. Hence the bounding of tool/reasoning string leaves rather than dropping history.

## Validation and benchmark

`scripts/benchmark-ahp-persistence.cjs <path-to-out/ahp/index.js>` builds 20 sessions x 50 turns x 20,000 tool-result chars (20 MB of tool text), runs five isolated child processes for save and five for load, records elapsed time, maximum timer gap (5 ms interval) and peak-RSS growth, and finally holds the lock 50 ms to simulate a sibling host. The baseline is `git archive f1c4230` compiled in a temp folder with this install's `node_modules`.

Measured (medians of 5 isolated runs, local tmp filesystem):

| Measurement                    |           Baseline f1c4230 |          This branch |
| ------------------------------ | -------------------------: | -------------------: |
| Save completion                |                   137.8 ms |              64.7 ms |
| Save max timer gap             |                   165.2 ms |              21.9 ms |
| Save peak RSS growth           |                    49.4 MB |              40.9 MB |
| Bytes written                  |                  8,387,671 |            1,342,135 |
| Sessions / turns kept          |                   20 / 412 |           20 / 1,000 |
| Load (20.3 MB file) completion |                   150.0 ms |             106.6 ms |
| Load max timer gap             |                   150.3 ms |              12.3 ms |
| Load peak RSS growth           |                   105.7 MB |             102.7 MB |
| Occupied lock (50 ms)          | timed out after 2,018.7 ms | saved after 154.1 ms |

Caveats: synthetic uniform fixture; tool text compresses to markers so the size gain is fixture-specific; peak RSS is process-wide `maxRSS` and noisy; the remaining first-save serialization is chunked but each chat state is still stringified synchronously (largest real chat 708 KB); worker start-up adds a few ms for files < 1 MiB, which therefore are parsed inline. Real tool outputs beyond 1,024 characters are not recoverable from the reconnect cache; the authoritative transcripts remain in each provider's own storage.

Tests (`ahpPersistenceLarge.test.ts`, `codexTranscript.test.ts`, existing suites): 20 MB size bound with all turns preserved, event-loop gap on save and load, incremental re-save, debounce coalescing, fail-closed on an unmergeable valid state (file bytes unchanged, no temp files), quarantine of unparseable state, failed save not advancing the sequence, 4 concurrent writer processes without lost sessions, Codex cache invalidation on size change with preserved mtime.
