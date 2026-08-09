# PLAN — AHP changeset channel

**Created:** 2026-08-09
**Status:** pending
**Origin:** optional AHP channel split by the 2026-08-09 audit.
**Depends on:** stable core AHP host and client transport.

## Outcome

Expose changed-file review and apply/reject operations as an optional,
host-authoritative AHP capability.

## Work

- Project `src/ui/changedFiles*.ts` state into dedicated changeset channels.
- Define explicit ownership and apply/reject authority.
- Correlate changesets to stable session/chat/turn identity.
- Reject stale or conflicting decisions deterministically.
- Gate the entire surface behind an advertised capability and rollback switch.
- Add a threat model covering path traversal, symlinks and stale diffs.

## Acceptance criteria

- Clients observe identical ordered changeset state.
- Apply/reject is idempotent and reconciles optimistic clients.
- Existing workspace-root and permission policy is enforced.
- No file content outside allowed roots enters snapshots or replay.

## Validation and rollback

Add conformance, policy, conflict and reconnect tests; run `npm run verify`.
Disable the capability to restore the existing changed-files UI path.
