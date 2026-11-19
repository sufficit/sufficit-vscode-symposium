# PWA migration to AHP

Status: **Completed**
Date: 2026-08-09

## Activity

Made the browser PWA the first production client of the authenticated AHP host,
while preserving REST+SSE as an explicit rollback transport.

## Delivered

- official `AhpClient`, `AhpStateMirror` and `WebSocketTransport` in the PWA bundle;
- browser-safe Symposium chat/session mirror and shared legacy-view selectors;
- authenticated WebSocket subprotocol without placing the Bridge token in a URL;
- root/session/chat subscription, tail reconnect, snapshot fallback and
  duplicate `serverSeq` suppression;
- AHP create/open/send/cancel/queue/approval routing with client message IDs;
- accessible connecting/reconnecting/caught-up/failed live status;
- `symposium.bridge.pwaTransport` fallback setting (`ahp` or `rest-sse`).

## Validation

Host and strict webview typechecks, PWA bundling, multi-viewer convergence,
duplicate delivery, snapshot replacement, transcript translation and WebSocket
integration tests pass. Existing keyboard/focus and reduced-motion webview code
is reused unchanged.

## Outcome

The PWA now reads authoritative AHP state and writes AHP actions. REST+SSE remains
available only as the release-scoped compatibility path.
