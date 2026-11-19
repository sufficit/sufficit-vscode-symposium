# AHP client-provided tools

Status: **Completed**
Date: 2026-08-09

## Activity

Implemented an ephemeral registry for authenticated clients to contribute
temporary tools under explicit ownership and policy.

## Delivered

- host namespaced tool identities that cannot impersonate provider tools;
- per-client registration and schema-size limits;
- permission checks before invocation;
- per-tool concurrency and invocation timeout limits;
- deterministic abort of pending calls and registration cleanup on disconnect;
- no durable replay of tool registration or invocation payloads;
- independent capability advertisement and disable switch.

## Validation

Tests cover namespace normalization, duplicate/registration limits, permission
denial, timeout, pending-call abort and disconnect cleanup.

## Outcome

Client tools can participate without corrupting host tool state or surviving
their owning authenticated connection.
