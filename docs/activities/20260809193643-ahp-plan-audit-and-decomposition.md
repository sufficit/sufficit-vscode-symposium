# Activity — AHP implementation audit and backlog decomposition

**Status:** complete
**Completed:** 2026-08-09
**Audited baseline:** `@microsoft/agent-host-protocol@0.6.0`

## Outcome

The aggregated AHP phases 1–6 plan was checked against the current source tree,
tests, package metadata and Git history. Completed work remains represented by
the existing Phase 0 activity; unimplemented work is now split into focused,
independently executable plans.

## Evidence reviewed

- `src/ahp/` contains only the transport-independent `channelStore.ts` core.
- `src/test/ahpChannelStore.test.ts` covers sequencing, reduction, reconnect,
  rejection and subscriber isolation for that core.
- `@microsoft/agent-host-protocol` remains exact-pinned to `0.6.0` in both
  package manifests.
- commit `9143f5e` introduced the Phase 0 implementation and its tests.
- no host runtime, channel models/URI boundary, agent-event projection,
  persistence layer, `/ahp` WebSocket endpoint, AHP client transport or
  optional AHP channel implementation exists in production code.

## Classification

The implemented scope is exactly the Phase 0 authoritative channel foundation,
already archived in
[`20260727-ahp-phase-0-foundation-complete.md`](20260727-ahp-phase-0-foundation-complete.md).
No portion of phases 1–6 met its acceptance criteria, so no completion activity
was manufactured for future work.

## Documentation changes

- removed the stale aggregated `PLAN-AHP-PHASES-1-6.md` document;
- created one plan for each core delivery boundary;
- separated every optional channel into its own capability-scoped plan;
- separated compatibility-path retirement from client migration;
- updated AHP adoption and Phase 0 documentation to point to the individual
  backlog.

## Resulting execution model

Core plans follow explicit dependencies from host models through projection,
shadow validation, persistence, remote transport and client migration. Optional
channels remain independent after the core runtime is stable. Each plan carries
its own acceptance criteria, validation and rollback boundary so completion can
later be archived as one dated activity without rewriting a monolithic roadmap.
