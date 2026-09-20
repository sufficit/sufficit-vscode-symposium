# Legacy render and Bridge client paths retired

Status: **Completed**
Date: 2026-08-11

## Activity

Removed the compatibility paths that survived the AHP client migration, once
every production surface read and wrote the same host runtime.

- Proved no chat-state consumer of the legacy host-to-webview variants
  remained.
- Removed the REST+SSE chat facade. The supporting HTTP Bridge routes stayed,
  but they no longer own chat state or commands.
- Removed the webview sinks and the UI replay path from `RenderStream`.
- Removed the migration switches and promoted the AHP projection runtime to an
  always-on production component.
- Rendered `ChatState` directly in the editor, sidebar and PWA clients.
- Updated the README, architecture and protocol documentation to the shipped
  behaviour.

## Compatibility window

`v2026.811.4` through `v2026.811.6`. Retirement shipped only after that
release-scoped window, on a revertable commit boundary.

Persisted render transcripts were not deleted and remain readable by the
controller for internal transcript and migration purposes; what retirement
removed is their use as a UI replay path.

## Acceptance

The AHP runtime is the sole authority for shared root, session and chat state.
No production surface depends on legacy render replay to reconstruct state.
Reopen, queue, approval, reconnect and multi-viewer behaviour did not regress,
checked with the architecture and reference checks, the full contract, DOM and
integration suites, and `npm run verify:package`.

Retired plan: `docs/plans/PLAN-AHP-legacy-transport-retirement.md`, created
2026-08-09, deleted once this record existed.
