# Authenticated AHP WebSocket transport

Status: **Completed**
Date: 2026-08-09

## Activity

Exposed the host runtime through an opt-in `/ahp` WebSocket endpoint on the
existing Bridge server without removing REST/SSE.

## Delivered

- JSON-RPC/AHP initialization, ping, reconnect, subscribe, unsubscribe,
  session list/create/dispose and allowlisted action dispatch;
- pre-upgrade Bridge-token and Host validation; URL tokens are rejected;
- browser-compatible authenticated subprotocol plus bearer/custom headers;
- shared Bridge working-root and session-permission policy;
- limits for frames, connections, subscriptions, request rates, malformed
  messages and queued writes, including slow-consumer disconnects;
- exact runtime `ws` dependency and typed transport tests.

## Validation

Tests cover auth, protocol negotiation, initial snapshots, two-client ordering,
tail replay, snapshot fallback, malformed/oversized frames, backpressure and
root-policy denial.

## Outcome

Independent AHP clients can observe the same authoritative action order while
legacy Bridge and PWA paths continue to operate unchanged.
