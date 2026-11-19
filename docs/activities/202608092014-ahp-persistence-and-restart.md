# AHP persistence and restart recovery

Status: **Completed**
Date: 2026-08-09

## Activity

Added durable, versioned AHP snapshots and bounded action tails under extension
global storage.

## Delivered

- protocol/schema versioning and highest-sequence persistence;
- restrictive directory/file modes with temporary-file atomic rename;
- schema, URI ownership, sequence and byte-limit validation;
- corrupt/incompatible quarantine with diagnostics;
- action-threshold compaction, clean shutdown save and recursive secret redaction.

## Validation

Round-trip, sequence continuation, corruption, unsupported schema, total and
per-session limits, redaction, compaction and atomic cleanup tests pass.

## Outcome

Extension restarts restore AHP-visible state safely while provider transcripts
and the existing Symposium ledger remain independent.
