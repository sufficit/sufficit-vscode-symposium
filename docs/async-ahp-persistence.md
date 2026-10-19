# AHP async persistence

## Runtime contract

`AhpPersistence.load()`, `save()`, `flush()` and `dispose()` are asynchronous. `save()` captures a runtime snapshot immediately, queues it, and resolves only after its batch has been serialized and atomically installed. Saves captured in the same pending batch are coalesced to the newest complete state. Callers that intentionally persist in the background (for example `maybeSave`) handle the returned rejection; shutdown uses `dispose(runtime)` to save the final snapshot and drain the queue.

Disk reads/writes and shared-file-lock waiting use promises. The lock heartbeats its owner record while held, recovers abandoned owners, and waits without `Atomics.wait`; the temp-file-plus-rename transaction and cross-host session merge remain serialized. Existing validation, size limits, compaction, redaction and corrupt/incompatible-state quarantine are preserved. Activation awaits load before wiring the restored AHP runtime. The VS Code disposable callback starts async disposal and reports any failure to the extension log.

`JsonSessionRepository` keeps its in-memory view synchronous, while mutations return promises for durable completion. Its write queue coalesces pending provider updates and applies each read/merge/write under the same non-blocking cross-process lock. `SessionIndex` awaits writes during scan and forget, and its async disposal flushes queued work. The initial repository load remains synchronous because construction must seed the current synchronous `listCached()` API before its first consumer.

## Validation and benchmark

The reproducible harness is `scripts/benchmark-ahp-persistence.cjs`. It writes eight synthetic 300 kB session titles (7,209,839-byte snapshot), runs five samples, measures completion time and maximum timer gap, and then holds the shared lock for 50 ms to simulate a sibling Extension Host. To compare the original revision, archive the base commit to a clean temporary folder, link that folder's `node_modules` to this install, compile it with `npm run compile:test`, and pass its `out/ahp/index.js` path to the harness. Run the same harness against this branch's `out/ahp/index.js`.

Observed in this worktree (Node/npm installed via the repository lockfile; local temporary filesystem):

| Measurement | Baseline | Async implementation |
| --- | ---: | ---: |
| Median completion, 7.21 MB payload (5 runs) | 38.40 ms | 39.97 ms |
| Median maximum timer gap, 7.21 MB payload | 38.53 ms | 35.41 ms |
| Simulated occupied lock: outcome | timed out | saved |
| Simulated occupied lock: completion / release-timer delay | 4,024.92 / 4,024.79 ms | 62.05 / 49.24 ms |

The normal-write measurements are close and variable; this change is not presented as a general speedup. In that path, synchronous snapshot export/JSON serialization still runs on the Extension Host thread. The demonstrated gain is that lock contention now yields to the event loop and completes after the peer releases the lock instead of blocking through retries and timing out.

Validation completed on this branch: `npm run verify` passed; `npm test` passed all 911 tests (0 failures). Tests cover async lock serialization/timer responsiveness and abandoned-owner recovery, AHP round-trip, quarantine, limits, compaction, multihost merge, projection disposal, JSON repository multihost updates, and a stale scan invalidated during pending persistence.
