# PLAN — authenticated AHP WebSocket transport

**Created:** 2026-08-09
**Status:** pending
**Origin:** remaining AHP remote-transport work identified by the 2026-08-09 audit.
**Depends on:** shadow-validated host runtime and persistence/reconnect semantics.

## Outcome

Expose the authoritative AHP runtime to remote clients through an opt-in `/ahp`
WebSocket endpoint while retaining the existing REST+SSE Bridge.

## Work

- Add `src/ahp/wireProtocol.ts` and `src/ahp/webSocketServer.ts`.
- Authenticate before upgrade with the Bridge token; never accept it in a URL.
- Implement initialization, version/capability negotiation, ping, reconnect,
  subscribe/unsubscribe, session list/create/dispose and action dispatch.
- Reuse Bridge host, root, permission and local-tool policy.
- Validate all inbound frames and allowlist dispatch by channel/capability.
- Bound frame bytes, connections, subscriptions, replay distance, queued
  writes, malformed frames and connection rate.
- Apply per-client backpressure and disconnect slow consumers.
- Log identity and rejection reason without payload secrets.

## Acceptance criteria

- Authenticated clients observe one identical global action order.
- Retained reconnect replays only the tail; old reconnect returns snapshots.
- Unauthorized, unsupported, malformed and over-limit requests fail in tests.
- A slow client cannot block sessions or other subscribers.
- REST+SSE Bridge and PWA behavior remain unchanged.
- An independent AHP client passes a manual interoperability check.

## Validation

Add `src/test/ahpWebSocket.test.ts` with auth, negotiation, reconnect,
concurrency, policy and backpressure cases; run `npm run verify:package`.

## Rollback

Disable the endpoint setting. REST+SSE remains available against the existing
controller path until client migration is proven.
