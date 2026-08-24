# Sufficit Relay Protocol — Public Symposium access

Status: **implemented for HTTP and AHP WebSocket traffic**. The implementation
is split between this extension and the `sufficit-ai` public gateway; both must
be deployed with multiplexing support for public PWA chat to work.

## Goal and topology

The extension opens one outbound, authenticated WebSocket to the gateway. HTTP
requests and browser WebSockets are multiplexed over that control connection,
so the PWA can be opened from any device without Tailscale, port forwarding or
an inbound host port.

```text
Browser ──HTTPS/WSS──► /symposium?machineId=<uuid>&path=/pwa/|/ahp
                                  │
                         Sufficit public gateway
                                  │ JSON control messages
                                  ▼
                         Extension relay client
                                  │ HTTP/WS loopback
                                  ▼
                          127.0.0.1:47600
```

## Endpoints

### `POST /api/symposium/relay/register`

The authenticated extension registers its stable machine UUID before every
connection or reconnection.

```http
POST /api/symposium/relay/register
Authorization: Bearer <sufficit-jwt>
Content-Type: application/json

{ "machineId": "550e8400-e29b-41d4-a716-446655440000" }
```

```json
{
  "ok": true,
  "relayWsUrl": "wss://ai.sufficit.com.br/symposium?ws=relay",
  "publicUrlPrefix": "https://ai.sufficit.com.br/symposium?machineId=<owner-scoped-id>"
}
```

The gateway accepts only a canonical UUID. It derives the public relay ID from
that UUID and the authenticated Sufficit user, so the same local UUID under a
different account cannot address or replace the owner's relay connection.

### Extension control WebSocket

```text
wss://ai.sufficit.com.br/symposium?ws=relay&machineId=<uuid>&token=<jwt>
```

The JWT query parameter is consumed only for this control connection, validated
by the normal gateway JWT handler and resolved to a Sufficit user ID. The
gateway rejects unauthenticated upgrades with HTTP 401. Once connected, the
extension sends `register`; the gateway verifies its prior user/machine binding.

### Public HTTP and WebSocket route

```text
https://ai.sufficit.com.br/symposium?machineId=<owner-scoped-id>&path=/pwa/
wss://ai.sufficit.com.br/symposium?machineId=<owner-scoped-id>&path=/ahp
```

HTTP is translated to `request`/`response` messages. A WebSocket upgrade is
accepted only for `/ahp`, after the extension has opened the local socket and
reported the negotiated AHP subprotocol. An offline machine or unavailable
local AHP endpoint returns HTTP 503 before upgrade.

## Control protocol

All control messages are JSON WebSocket text messages. Application WebSocket
payloads are Base64 encoded inside them.

### Session and HTTP messages

```jsonc
// extension -> gateway
{ "type": "register", "machineId": "550e8400-e29b-41d4-a716-446655440000" }
{ "type": "heartbeat" }
{ "type": "response", "id": "<id>", "status": 200, "headers": {}, "body": "..." }
{ "type": "response-chunk", "id": "<id>", "chunk": "...", "done": false }

// gateway -> extension
{ "type": "registered", "publicUrl": "https://ai.sufficit.com.br/symposium?machineId=<owner-scoped-id>" }
{ "type": "request", "id": "<id>", "method": "GET", "path": "/pwa/", "headers": {}, "body": "" }
```

The extension reconnects with exponential backoff (up to 60 seconds) and sends
a heartbeat every 25 seconds. HTTP requests time out at the gateway after 120
seconds.

### Multiplexed AHP WebSockets

```jsonc
// gateway -> extension: open local ws://127.0.0.1:<bridgePort>/ahp
{
  "type": "socket-open",
  "id": "<socket-id>",
  "path": "/ahp",
  "protocols": ["ahp.v0.6", "symposium-token.<base64url-token>"]
}

// extension -> gateway: local handshake succeeded
{ "type": "socket-opened", "id": "<socket-id>", "protocol": "ahp.v0.6" }

// either direction: one complete text or binary message
{ "type": "socket-frame", "id": "<socket-id>", "data": "<base64>", "binary": false }

// either direction
{ "type": "socket-close", "id": "<socket-id>", "code": 1000, "reason": "done" }
```

The browser's `Sec-WebSocket-Protocol` values are forwarded to local AHP. This
preserves both version negotiation and the `symposium-token.*` authentication
protocol. The negotiated protocol is returned to the browser upgrade.

Limits and validation:

- only local `/ahp` is accepted; arbitrary URLs and bridge paths are rejected;
- at most 16 valid WebSocket subprotocols are forwarded;
- each decoded application message is limited to 1 MiB;
- the gateway buffers at most 32 extension frames per public socket;
- close codes/reasons propagate in both directions, with invalid reserved codes
  normalized;
- dropping or replacing the control connection closes all of its child sockets.

## Security and deployment

- The control connection requires a valid Sufficit JWT. Its public relay ID is
  deterministically scoped to that user and local machine UUID; another user
  cannot collide with or replace the connection even if the UUID is known.
- The public URL remains a capability URL. The PWA additionally authenticates
  to the bridge with its random bridge token; the relay does not bypass bridge
  policy (`allowedRoots`, `sessionPermission`, tools or vault restrictions).
- Tokens are never written to logs. Query tokens should still be kept out of
  analytics and proxy access logs.
- Relay registries are process-local. A multi-node gateway therefore needs
  sticky routing for registration, control WebSocket and public requests, or a
  shared relay/session implementation.
- Deploy the matching `sufficit-ai` gateway before relying on public `/ahp`.
  Older gateways can serve HTTP PWA assets but cannot carry the AHP socket.

## Implementation map

- Extension control/HTTP client: `src/net/relayClient.ts`
- Extension child-socket multiplexer: `src/net/relaySocketTunnel.ts`
- Registration API client: `src/sync/hubClient.ts`
- Bridge lifecycle: `src/api/bridge.ts`
- Gateway route: `sufficit-ai/api/Startup.cs`
- Gateway relay registry/HTTP proxy:
  `sufficit-ai/runtime/Integrations/Symposium/SymposiumRelayService.cs`
- Gateway AHP multiplexer:
  `sufficit-ai/runtime/Integrations/Symposium/SymposiumRelayWebSockets.cs`
