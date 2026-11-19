# Agent Host Protocol

Symposium acts as the AHP host. Agent adapters run below it and normalize
backend events. The editor and sidebar connect through a MessagePort. The
PWA connects to the authenticated `/ahp` WebSocket.

The host owns shared state and publishes actions in `serverSeq` order.
Clients reconnect with retained actions or a fresh snapshot. Clients submit
messages through `symposium/messageSubmitted`. The host queue owns
`chat/pendingMessage*` state changes.

## Host and channels

Symposium now exposes one AHP contract above every adapter:

| Symposium producer | Authoritative AHP representation |
|---|---|
| adapters list and model pickers | `ahp-root://` agents |
| `LiveSessions` entry | `ahp-session:/<uuid>` |
| one `ChatController` conversation | default `ahp-chat:/<uuid>` |
| controller history/live events | chat snapshot + globally ordered actions |
| `busy`, errors and notices | session/chat status and activity |
| `ChatQueue` | `chat/pendingMessage*` |
| approval request/response | tool-call ready/confirmed lifecycle |
| changed files and approve/reject | changeset channel and operations |
| terminal-backed sessions | terminal channels |
| local resources and attachments | `resource*` commands and content refs |
| Bridge token | WebSocket transport auth |
| Sufficit/provider credentials | AHP protected resources/authenticate |

The result is one live session that can be opened in the sidebar, an editor,
the PWA and another machine without any client becoming the source of truth.

## Version policy

AHP is still a draft and its wire types can change incompatibly. The npm client
is therefore exact-pinned, never ranged with `^` or `~`.

The source tree compiles to CommonJS for tests, while the official
TypeScript SDK is ESM-only. Host-side code uses its declarations as the wire contract
without loading its runtime from CommonJS. Browser/PWA bundles can use the
official `AhpClient`, `AhpStateMirror` and `WebSocketTransport` directly.
Server-side code uses the official types plus Symposium's own host
implementation because the SDK does not ship a TypeScript server.

An AHP upgrade requires:

1. reading the specification and SDK changelogs;
2. updating the exact package version;
3. compiling the structural contract;
4. running reducer/projection and wire conformance tests;
5. validating against an independent client such as AHPX;
6. only then advertising the new protocol version.

## Transport

The bridge authenticates the WebSocket upgrade and requires a supported
subprotocol. It checks the creation policy and validates client actions
against the channel. Use the [discovery manifest](../reference/api-discovery.md)
for the advertised wire version and capabilities. Optional channels require
host enablement and capability advertisement.

The host persists completed turns, session metadata, and genuine pending work.
On restart, it clears process-local activity, stale clients, and approvals.
See [AHP persistence](ahp-persistence.md) for cache limits and
[session history](session-history.md) for transcript paging.

## Required invariants

- The AHP host is the only authority for shared session state.
- One server sequence orders actions across all channels.
- A client action is applied once, echoed with its origin, or echoed rejected.
- Backend-specific payloads stay behind the projection; `_meta` is optional
  enhancement, never required for a coherent client.
- Session and chat URIs are stable Symposium UUIDs, not temporary `new-N` keys
  or provider-specific resume IDs.
- Durable user-visible state is reconstructable from snapshots and actions.
- Protocol notifications are never treated as durable replay data.
- Features are gated by advertised capabilities, not provider-name checks.
- Existing Bridge security policy remains the minimum policy for remote AHP.

## Validation

Run `npm run verify` for reducer, projection, reconnect, and persistence
tests. Use the [offline test procedure](testing.md) to check the Bridge.

## Delivery record

The 2026-08-09 implementation completed the host, projections, persistence,
authenticated transports and all three clients:

1. [Host runtime and channel models](../activities/20260809201446-ahp-host-runtime-and-channel-models.md)
2. [Normalized agent-event projection](../activities/20260809201447-ahp-agent-event-projection.md)
3. [Shadow projection and parity diagnostics](../activities/20260809201448-ahp-shadow-projection.md)
4. [Persistence and restart recovery](../activities/20260809201449-ahp-persistence-and-restart.md)
5. [Authenticated WebSocket transport](../activities/20260809201450-ahp-authenticated-websocket.md)
6. [PWA client migration](../activities/20260809202643-ahp-pwa-client-migration.md)
7. [Editor and sidebar migration](../activities/20260809210800-ahp-editor-sidebar-migration.md)

Optional capability packages are also implemented behind explicit host
enablement and advertised capability gates:

- [Changeset channel](../activities/20260809210801-ahp-changeset-channel.md)
- [Terminal channel](../activities/20260809210803-ahp-terminal-channel.md)
- [Resource and attachment channels](../activities/20260809210802-ahp-resource-channel.md)
- [Customization channels](../activities/20260809210804-ahp-customization-channels.md)
- [Client-provided tools](../activities/20260809210805-ahp-client-tools.md)
- [Telemetry measurements](../activities/20260809210806-ahp-telemetry.md)

Legacy transport retirement completed after the editor/sidebar and PWA clients
remained released across the required compatibility window. See the completed
[retirement record](../activities/20260811-ahp-legacy-transport-retired.md).
