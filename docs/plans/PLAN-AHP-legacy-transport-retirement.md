# PLAN — retire legacy render and Bridge client paths

**Created:** 2026-08-09
**Status:** completed (2026-08-11)
**Origin:** compatibility cleanup intentionally deferred from AHP client migration.
**Depends on:** stable PWA, editor and sidebar AHP clients for at least one release.

## Outcome

Remove obsolete client synchronization paths only after all production surfaces
read and write the same AHP host runtime.

## Work

- [x] Prove there are no remaining chat-state consumers of legacy
  host-to-webview variants.
- [x] Remove the REST+SSE chat facade; supporting HTTP Bridge routes remain.
- [x] Remove webview sinks and UI replay from `RenderStream`.
- [x] Remove migration switches and promote the AHP projection runtime to an
  always-on production component.
- [x] Render `ChatState` directly in editor, sidebar and PWA clients.
- [x] Update README, architecture and protocol documentation to shipped behavior.

## Acceptance criteria

- AHP runtime is the sole authority for shared root/session/chat state.
- No production surface depends on legacy render replay for reconstruction.
- The REST+SSE chat facade is absent; supporting HTTP routes do not own chat
  state or commands.
- Removal does not regress reopen, queue, approval, reconnect or multi-viewer
  behavior.

## Validation

Use architecture/reference checks to prove no consumer remains, run the full
contract/DOM/integration suites and execute `npm run verify:package`.

## Rollback

Ship retirement only after a release-scoped compatibility window. Preserve a
revertable commit boundary and do not delete persisted user transcripts.

The window covered `v2026.811.4` through `v2026.811.6`. Existing persisted
render transcripts remain readable by the controller for internal transcript
and migration purposes; retirement only removed their use as a UI replay path.
