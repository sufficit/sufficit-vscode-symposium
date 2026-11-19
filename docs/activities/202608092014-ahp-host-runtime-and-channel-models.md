# AHP host runtime and channel models

Status: **Completed**
Date: 2026-08-09

## Activity

Implemented the transport-independent AHP host that owns stable channel
identities, authoritative snapshots, ordered actions and session/chat lifecycle.

## Delivered

- strict constructors and parsers for root, session, chat, terminal, changeset,
  annotations and OTLP channel URIs;
- deterministic UUID mapping for durable native identities and random public
  identities for temporary sessions;
- pure root, session and chat reducers with one monotonic global sequence;
- atomic session/default-chat registration and disposal;
- bounded replay, reconnect snapshots, subscriptions and runtime export/restore;
- tests for URI boundaries, lifecycle, listener isolation, rejection and replay.

## Validation

Type checking, compilation and the AHP runtime/store unit suites pass. The new
production modules remain below the repository's 400-line hard limit.

## Outcome

Symposium now has one backend-neutral AHP authority that does not depend on a
webview, adapter or network transport.
