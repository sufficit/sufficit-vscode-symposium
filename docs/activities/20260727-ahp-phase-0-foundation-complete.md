# Activity — AHP phase 0 authoritative channel foundation

**Status:** complete
**Implemented:** 2026-07-27 in commit `9143f5e`
**Protocol baseline:** `@microsoft/agent-host-protocol@0.6.0`, exact-pinned

## Outcome

Symposium gained a transport-independent, host-authoritative channel primitive
without changing production session, webview or Bridge behavior. This creates a
testable base for gradual AHP adoption while avoiding two competing live state
authorities.

## Implemented scope

`src/ahp/channelStore.ts` provides:

- one monotonic `serverSeq` across all registered channels;
- pure reducer-driven channel state;
- host-authoritative snapshots stamped with sequence position;
- bounded reconnect replay with snapshot fallback after retention rollover;
- accepted and rejected client-action echoes;
- isolated subscriber fan-out;
- explicit missing/disposed-channel reporting;
- type-level alignment with the exact-pinned official AHP SDK.

`src/test/ahpChannelStore.test.ts` covers sequencing, reduction, subscriber
isolation, rejected actions, retained replay, rollover fallback and input
guards.

## Deliberate boundary

Phase 0 is not wired to `LiveSessions`, controllers, the webview, PWA or remote
transport. `ChatController` and `RenderStream` remain the production path. This
was intentional: event projection must prove parity in shadow mode before AHP
can become a client-facing authority.

## Benefit retained

- A backend-neutral synchronization core now exists below future transports.
- Replay and concurrency rules are testable without VS Code or a network.
- The exact protocol pin prevents an implicit draft-protocol upgrade.
- Production rollback is trivial because phase 0 has no live consumers.

## Remaining work

Host models, event projection, persistence, authenticated WebSocket transport,
PWA/editor migration and optional channels remain open. Their independent
plans are indexed in [`AHP-ADOPTION.md`](../AHP-ADOPTION.md#execution-backlog).
