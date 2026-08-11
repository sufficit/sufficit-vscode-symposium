# Sufficit Relay Protocol — Public access to Symposium without Tailscale

Status: **HTTP relay implemented; AHP WebSocket tunnelling pending**. The
extension HTTP client (`src/net/relayClient.ts`) is implemented; the gateway
server side and bidirectional WebSocket multiplexing are prerequisites.

## Goal

Let a user scan a QR code in the Symposium remote-access panel and open the PWA
from **any device** (phone, tablet, another computer) — no Tailscale app, no port
forwarding, no tunneling tool. The extension opens an **outbound** WebSocket to
the gateway; the gateway publishes a public URL that reverse-proxies HTTP
requests through that connection.

```
Browser/Phone ──HTTPS──► ai.sufficit.com.br/symposium/<machineId>/*
                                 │ (reverse proxy over WS)
                                 ▼ (outbound WS, opened by the extension)
                           Extension host ──► 127.0.0.1:47600 (bridge)
```

No inbound port is opened on the host machine. The connection is authenticated
with the user's Sufficit JWT (same OAuth identity used for the AI gateway).

---

## Gateway endpoints to implement

### 1. `POST /api/symposium/relay/register`

Validates the caller's JWT and returns the WebSocket URL + public URL prefix.

**Request:**
```http
POST /api/symposium/relay/register
Authorization: Bearer <sufficit-jwt>
Content-Type: application/json

{ "machineId": "550e8400-e29b-41d4-a716-446655440000" }
```

**Response (200):**
```json
{
  "ok": true,
  "relayWsUrl": "wss://ai.sufficit.com.br/symposium/relay",
  "publicUrlPrefix": "https://ai.sufficit.com.br/symposium/550e8400-e29b-41d4-a716-446655440000"
}
```

The gateway should:
- Validate the JWT (same validation as other `/api/symposium/*` endpoints).
- Optionally persist the `machineId` → user mapping (for `/api/symposium/remote-url` parity).
- Return 404 or `{ "ok": false }` if relay is not enabled on this gateway (the extension falls back to tailnet/local gracefully).

---

### 2. WebSocket server at `/symposium/relay`

Accepts outbound connections from extensions. Each connection is authenticated
and bound to a `machineId`.

**Connection URL (extension → gateway):**
```
wss://ai.sufficit.com.br/symposium/relay?machineId=<uuid>&token=<jwt>
```

The gateway validates the `token` query param (JWT) on the WS upgrade. If
invalid, reject the upgrade (HTTP 401).

Once connected, the extension sends a `register` message; the gateway responds
with `registered` and begins forwarding HTTP requests.

---

### 3. Public reverse proxy at `/symposium/<machineId>/*`

Any HTTP request to `https://ai.sufficit.com.br/symposium/<machineId>/*` is
forwarded to the extension's WS connection bound to that `machineId`. The
gateway translates the HTTP request into a relay `request` message, waits for
the `response` (or `response-chunk` stream), and writes it back to the HTTP
client.

The `machineId` in the path determines which WS connection to route to. If no
connection is registered for that `machineId`, return HTTP 503 (service
unavailable).

**Public URL** (what the QR encodes):
```
https://ai.sufficit.com.br/symposium/<machineId>/pwa?token=<bridge-token>
```

---

## Relay message protocol (JSON over WebSocket text frames)

### Extension → Gateway

#### `register`
```json
{ "type": "register", "machineId": "550e8400-..." }
```
Sent immediately after the WS opens. The gateway responds with `registered`.

#### `response` (complete HTTP response)
```json
{
  "type": "response",
  "id": "<request-uuid>",
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": "..."
}
```

#### `response-chunk` (streaming HTTP response)
```json
{ "type": "response-chunk", "id": "<request-uuid>", "chunk": "data: hello\n\n" }
{ "type": "response-chunk", "id": "<request-uuid>", "chunk": "", "done": true }
```
For a streaming HTTP response, the extension sends an initial `response` with
`"stream": true`, then `response-chunk` messages and a final chunk with
`"done": true`. Chat no longer uses this path.

#### `heartbeat`
```json
{ "type": "heartbeat" }
```
Sent every 25s. The gateway should respond with its own `heartbeat` (or treat
any message as alive). If no message is received for 60s, close the connection.

---

### Gateway → Extension

#### `registered`
```json
{ "type": "registered", "publicUrl": "https://ai.sufficit.com.br/symposium/<machineId>" }
```
Confirms the machine is registered and tells the extension its public URL. The
extension uses this URL to build the QR code.

#### `request` (HTTP request to proxy)
```json
{
  "type": "request",
  "id": "<request-uuid>",
  "method": "GET",
  "path": "/pwa/",
  "headers": { "host": "ai.sufficit.com.br" },
  "body": ""
}
```
The `path` is relative to the bridge root (e.g. `/pwa/`, `/backends`).
The extension proxies this to `http://127.0.0.1:<bridgePort><path>` and sends
back a `response` (or `response-chunk` stream).

#### `heartbeat`
```json
{ "type": "heartbeat" }
```

---

## Security considerations

1. **JWT authentication**: every WS connection is authenticated with the user's
   Sufficit JWT. A `machineId` is only reachable by the user who owns it.
2. **Bridge token**: the QR encodes the bridge's bearer token (`?token=...`).
   Anyone who scans the QR has the bridge token — but the bridge's policy
   (`allowedRoots`, `sessionPermission`, `allowVaultResolve`, etc.) still
   applies to every request. The relay does not bypass bridge policy.
3. **machineId isolation**: each `machineId` maps to exactly one WS connection.
   A request to `/symposium/<machineId>/*` only reaches that connection. There
   is no cross-machine access.
4. **No inbound ports**: the connection is entirely outbound (extension →
   gateway). No port forwarding, no firewall rules on the host.

---

## Extension-side implementation

- **Client**: `src/net/relayClient.ts` — `RelayClient` class with reconnect
  (exponential backoff up to 60s), heartbeat (25s), and HTTP proxy via `fetch`
  to the local bridge.
- **Registration**: `src/sync/hubClient.ts` — `registerRelay(machineId)` calls
  `POST /api/symposium/relay/register`.
- **Integration**: `src/api/bridge.ts` — `startRelay()` called after the bridge
  listens; `getRelayPublicUrl()` exposed for the QR panel.
- **QR**: `src/ui/remoteAccessPanel.ts` — prefers the relay URL over the
  tailnet hostname when available.
- **Config**: `symposium.bridge.relay` = `"auto"` (default) | `"off"`.
- **machineId**: persisted to `~/.symposium/relay-machine-id` (stable across
  reloads, 0600 perms).

---

## What the gateway needs (checklist)

- [ ] `POST /api/symposium/relay/register` — validates JWT, returns `{ ok, relayWsUrl, publicUrlPrefix }`
- [ ] WebSocket server at `/symposium/relay` — validates JWT on upgrade, binds `machineId`
- [ ] Reverse proxy at `/symposium/<machineId>/*` — translates HTTP → relay `request`, waits for `response`/`response-chunk`, writes back
- [ ] Heartbeat: treat any message as alive; close after 60s silence
- [ ] `machineId` isolation: one WS connection per machineId; route by path prefix
- [ ] 503 when no connection registered for the requested `machineId`
- [ ] Multiplex browser WebSocket open/frame/close messages to local `/ahp`,
      including `Sec-WebSocket-Protocol`; until this exists, the AHP PWA works
      through direct/tailnet Bridge URLs but not through the public relay.
