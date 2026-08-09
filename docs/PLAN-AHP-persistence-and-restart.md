# PLAN — durable AHP snapshots and restart recovery

**Created:** 2026-08-09
**Status:** pending
**Origin:** remaining AHP persistence work identified by the 2026-08-09 audit.
**Depends on:** host runtime/models; shadow projection should establish parity first.

## Outcome

Restore durable AHP-visible state after extension restart without accepting
stale actions as current authority.

## Work

- Add `src/ahp/persistence.ts` for versioned snapshots and a bounded action tail
  under extension global storage `ahp/`.
- Persist protocol version, local schema version and highest server sequence.
- Write temporary files and atomically rename with restrictive permissions.
- Validate schema, size, URI ownership and sequence monotonicity on load.
- Quarantine corrupt or incompatible files instead of partially applying them.
- Compact after a configurable action count and on clean shutdown.
- Redact protected resources and denied `_meta` keys before persistence.

## Acceptance criteria

- Restart restores durable visible state and resumes above every stored sequence.
- Corrupt/truncated data cannot prevent extension activation.
- Unsupported schemas fall back cleanly with a clear diagnostic.
- Explicit per-session and total byte limits are enforced.
- Existing Symposium transcript persistence remains independent.

## Validation

Add `src/test/ahpPersistence.test.ts` for round trips, rollover, corruption,
schema migration, redaction, atomic recovery and limits; run `npm run verify`.

## Rollback

Disable loading and quarantine/rename the AHP storage directory for diagnosis.
Do not alter provider transcripts or the Symposium ledger.
