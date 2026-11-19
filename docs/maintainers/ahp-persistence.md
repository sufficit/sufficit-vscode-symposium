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

## Diagnose and test

Run `node scripts/diagnose-ahp-state.cjs <state.json>` to print aggregate
counts and sizes without reading conversation text into the output. The
persistence directory is the `ahp` subdirectory of the extension's VS Code
global storage.

Run `npm run verify` for persistence and concurrent writer tests. The
[benchmark script](../../scripts/benchmark-ahp-persistence.cjs) accepts a
compiled AHP entry point, produced by `npm run compile:test` before the host
bundle removes intermediate modules. It measures save and load time, event
loop delay, and peak memory on synthetic state. Results depend on payload and
filesystem characteristics.
