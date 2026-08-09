# PLAN — AHP terminal channel

**Created:** 2026-08-09
**Status:** pending
**Origin:** optional AHP channel split by the 2026-08-09 audit.
**Depends on:** stable core AHP host and client transport.

## Outcome

Expose terminal output, claims, resize and input through a bounded optional AHP
channel without leaking shell environment data.

## Work

- Define terminal state/actions and explicit input ownership claims.
- Stream bounded output with reconnect snapshot/tail semantics.
- Enforce session permission mode and local-tool policy for terminal actions.
- Redact environment values and credentials from durable state and diagnostics.
- Bound output, input, resize rate, replay and disconnected-client queues.
- Advertise the channel only when supported and enabled.

## Acceptance criteria

- One client owns input at a time; disconnect releases claims safely.
- Slow viewers do not block the terminal or other subscribers.
- Reconnect produces coherent bounded output without duplication.
- No raw environment map or secret is persisted or replayed.

## Validation and rollback

Add claim-race, reconnect, backpressure, policy and redaction tests; run
`npm run verify`. Disable the terminal capability to retain current behavior.
