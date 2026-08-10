# Centralized permanent cleanup of session artifacts

Status: **Completed**
Date: 2026-08-09

## Activity

Centralized deletion of Symposium-owned session persistence so every adapter
has the same permanent-delete semantics.

## Delivered

- one `removeLocalSessionArtifacts` boundary under `src/sessions`;
- safe session-id validation, deletion tombstone and idempotent complete-ledger
  removal;
- common delete command invokes shared cleanup only after provider scrub
  succeeds;
- OpenAI no longer owns deletion of the shared Symposium ledger;
- removal of the unused render-file-only deletion API;
- render JSONL tests for ordering, size limits and corrupt/partial lines;
- history fallback, restored state and DOM reconstruction coverage through the
  AHP projection and webview suites.

## Validation

Tests cover full ledger removal, already-absent artifacts, traversal rejection,
render recovery and adapter-history fallback. `npm run lint`, `npm test` and
`npm run compile` pass.

## Outcome

Provider adapters scrub only provider-owned storage. Once that succeeds, the
common command removes messages, rich render output and other Symposium ledger
artifacts without leaving backend-dependent recoverable data.
