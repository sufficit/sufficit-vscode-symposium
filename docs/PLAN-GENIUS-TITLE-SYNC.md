# Genius title synchronization

## Objective and acceptance

A rename in Symposium appears in Genius Desktop, and a rename in Genius Desktop appears in open Symposium lists and headers. Existing local Symposium title overrides are reconciled once with the native Genius title. Other backends retain local title behavior.

## Terrain and constraints

- Symposium's rename command only calls `SessionStore.setTitle`; custom titles shadow the Genius CLI session list.
- Genius already persists titles, and `genius sessions --json` returns them. A new CLI rename command is being added in companion Genius issue #1020.
- SessionIndex caches provider lists and Symposium surfaces refresh from that cache. Preserve unrelated session metadata and active turns.

## Checkpoints

- [ ] **Current:** Define reconciliation and failure behavior with tests.
- [ ] Route Genius renames through the CLI and migrate legacy local titles.
- [ ] Refresh open Symposium surfaces when Genius Desktop changes a title.
- [ ] Run package validation, document activity, and remove this plan.
- [ ] Deliver through PR/merge and install the VSIX locally and on development code-server.

## Decision

Genius owns the canonical title. Symposium keeps local titles for other adapters and clears the Genius override only after native rename succeeds.

## Validation

Pending.
