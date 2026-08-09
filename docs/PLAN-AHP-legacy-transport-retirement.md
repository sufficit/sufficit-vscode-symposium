# PLAN — retire legacy render and Bridge client paths

**Created:** 2026-08-09
**Status:** pending
**Origin:** compatibility cleanup intentionally deferred from AHP client migration.
**Depends on:** stable PWA, editor and sidebar AHP clients for at least one release.

## Outcome

Remove obsolete client synchronization paths only after all production surfaces
read and write the same AHP host runtime.

## Work

- Prove there are no remaining consumers of legacy host-to-webview variants.
- Make any retained REST+SSE facade read/write the AHP runtime rather than own
  independent state.
- Remove replay-specific `RenderStream` responsibilities no longer needed by UI.
- Remove migration switches and compatibility telemetry after the stability
  window.
- Update README, architecture and protocol documentation to shipped behavior.

## Acceptance criteria

- AHP runtime is the sole authority for shared root/session/chat state.
- No production surface depends on legacy render replay for reconstruction.
- REST+SSE, if retained, is only a facade over AHP state/actions.
- Removal does not regress reopen, queue, approval, reconnect or multi-viewer
  behavior.

## Validation

Use architecture/reference checks to prove no consumer remains, run the full
contract/DOM/integration suites and execute `npm run verify:package`.

## Rollback

Ship retirement only after a release-scoped compatibility window. Preserve a
revertable commit boundary and do not delete persisted user transcripts.
