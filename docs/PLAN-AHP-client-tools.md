# PLAN — AHP client-provided tools

**Created:** 2026-08-09
**Status:** pending
**Origin:** optional AHP channel split by the 2026-08-09 audit.
**Depends on:** stable core AHP host, authenticated clients and tool policy.

## Outcome

Allow authenticated clients to register temporary tools with explicit
ownership, policy checks and disconnect cleanup.

## Work

- Define registration, invocation, result and disposal actions.
- Bind every tool to one authenticated client and advertised capability.
- Remove registrations on disconnect, session disposal and capability change.
- Enforce permission mode, schema limits, timeouts and concurrency limits.
- Prevent client tools from impersonating host/provider tools.
- Keep tool payload secrets out of durable replay where policy requires.

## Acceptance criteria

- Only the owning connected client can service its tool invocation.
- Disconnect fails pending calls deterministically and removes registrations.
- Duplicate names and stale results cannot corrupt host tool state.
- Limits and policy apply before invocation reaches the client.

## Validation and rollback

Add ownership, disconnect, race, timeout, schema and policy tests; run
`npm run verify`. Disable the client-tools capability without affecting host
tools.
