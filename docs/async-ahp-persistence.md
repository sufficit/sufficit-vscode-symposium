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

`node scripts/diagnose-ahp-state.cjs <state.json>` prints only counts and sizes. Latest read-only sample (diagnostic JSON generated 2026-10-19 14:43:17 UTC): 20,366,392 B, 289 sessions and 579 snapshots; chat snapshots total 19,541,011 B (96%), other snapshots 188,446 B, root 164 B, retained actions 734 / 534,608 B. The chat snapshots contain 277 turns (at most one per chat), but `responseParts` account for 18,900,674 B (92.8% of the whole file): 6,267 tool calls consume 17,629,090 B, versus 2,122 markdown parts at 1,133,165 B, 195 reasoning parts at 66,029 B, and 304 notice parts at 63,213 B. The largest aggregate tool-call fields are `content` 6,086,787 B, `result` 4,649,989 B, `toolInput` 1,888,975 B, and `invocationMessage` 1,673,645 B. This identifies verbose tool payloads, not session/turn count or the retained action log, as the size driver. The diagnostic script's synchronous read/parse measured 24.5/40.9 ms. An earlier read-only sample was 20,527,971 B; the file changed between samples while the application was active. This agent did not write the real state file; the cause of that change is not established. The size-bounding therefore targets tool-call payloads first and preserves session and turn structure.

## Validation and benchmark

`scripts/benchmark-ahp-persistence.cjs <path-to-out/ahp/index.js>` builds 20 sessions x 50 turns x 20,000 tool-result chars (20 MB of tool text), runs five isolated child processes for save and five for load, records elapsed time, maximum timer gap (5 ms interval) and peak-RSS growth, and finally holds the lock 50 ms to simulate a sibling host. The baseline is `git archive f1c4230` compiled in a temp folder with this install's `node_modules`.

Measured (medians of 5 isolated runs, local tmp filesystem):

| Measurement                         |            Baseline f1c4230 |           This branch |
| ----------------------------------- | --------------------------: | --------------------: |
| Save completion                     |                   137.80 ms |              64.66 ms |
| Save max timer gap                  |                   165.18 ms |              21.89 ms |
| Save peak RSS growth                |                49,364,992 B |          40,931,328 B |
| Bytes written                       |                   8,387,671 |             1,342,135 |
| Sessions / turns kept               |                    20 / 412 |            20 / 1,000 |
| Load (20,325,135 B file) completion |                   149.95 ms |             106.57 ms |
| Load max timer gap                  |                   150.30 ms |              12.29 ms |
| Load peak RSS growth                |               105,705,472 B |         102,703,104 B |
| Occupied lock (50 ms)               | timed out after 2,018.68 ms | saved after 154.08 ms |

Caveats: synthetic uniform fixture; tool text compresses to markers so the size gain is fixture-specific; peak RSS is process-wide `maxRSS` and noisy; the remaining first-save serialization is chunked but each chat state is still stringified synchronously (largest real chat 708 KB); worker start-up would add a few ms to small files; files < 1 MiB are therefore parsed inline. Real tool outputs beyond 1,024 characters are not recoverable from the reconnect cache; the authoritative transcripts remain in each provider's own storage.

Tests (`ahpPersistenceLarge.test.ts`, `codexTranscript.test.ts`, existing suites): 20 MB size bound with all turns preserved, event-loop gap on save and load, incremental re-save, debounce coalescing, fail-closed on an unmergeable valid state (file bytes unchanged, no temp files), quarantine of unparseable state, failed save not advancing the sequence, 4 concurrent writer processes without lost sessions, Codex cache invalidation on size change with preserved mtime.
