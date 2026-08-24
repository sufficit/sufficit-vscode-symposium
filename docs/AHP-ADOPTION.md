# Agent Host Protocol adoption

Status: production migration and legacy transport retirement completed on 2026-08-11.

Target protocol: AHP `0.6.0`, pinned through
`@microsoft/agent-host-protocol@0.6.0`.

The implementation backlog is split into independently executable plans listed
below. Completed work is archived under `docs/activities/`.

## Decision

Symposium should become an AHP host, not treat AHP as another agent backend.

The existing `AgentAdapter` boundary remains below the host and continues to
translate Claude Code, Codex CLI, Copilot CLI and OpenAI-compatible APIs into
normalized agent events. ACP can later replace a backend-specific CLI
integration where an agent supports it. AHP sits above all adapters and exposes
one authoritative, agent-neutral state model to the editor, sidebar, PWA, CLI
and remote clients.

```text
 VS Code webview       PWA       CLI/mobile
        \               |             /
         +---------- AHP clients ----+
                       |
              WebSocket / in-process
                       |
        +-------- Symposium AHP host --------+
        | state · serverSeq · replay · auth  |
        +----------------+--------------------+
                         |
                LiveSessions / controllers
                         |
          +--------------+----------------+
          |              |                |
       Claude          Codex          Copilot/OpenAI
       CLI/ACP          CLI/ACP        CLI/HTTP/ACP
```

This layering follows AHP's scope: AHP coordinates multiple clients over shared
sessions; it does not replace the point-to-point protocol used between a host
and an agent.

## Shipped architecture

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

The source tree currently compiles to CommonJS for tests, while the official
TypeScript SDK is ESM-only. Phase 0 uses its declarations as the wire contract
without loading its runtime from CommonJS. Browser/PWA bundles can use the
official `AhpClient`, `AhpStateMirror` and `WebSocketTransport` directly.
Server-side code uses the official types plus Symposium's own host
implementation because the SDK does not currently ship a TypeScript server.

An AHP upgrade requires:

1. reading the specification and SDK changelogs;
2. updating the exact package version;
3. compiling the structural contract;
4. running reducer/projection and wire conformance tests;
5. validating against an independent client such as AHPX;
6. only then advertising the new protocol version.

## Delivery phases (completed)

### Phase 0 — authoritative channel core (implemented)

`src/ahp/channelStore.ts` provides the transport-independent state primitive:

- a single monotonic `serverSeq` across every channel;
- channel registration with pure reducers;
- snapshots stamped with `fromSeq`;
- bounded replay for reconnect;
- fallback to fresh snapshots when replay history rolled over;
- rejected client-action echoes that do not mutate authoritative state;
- per-channel subscription fan-out;
- reporting of missing/disposed channels.

It supplies the state primitive used by every production chat client.

### Phase 1 — Symposium-to-AHP projection

`AhpProjectionRuntime` follows `LiveSessions` and projects normalized events
into official state/actions:

- create root, session and default-chat states when a controller is registered;
- dispatch `chat/turnStarted` before calling `AgentSession.send`;
- map text, thinking, tools, approvals, usage, errors and completion into chat
  actions;
- mirror title, status, queue and archive changes into session/chat state;
- persist periodic channel snapshots plus the action tail under
  `~/.symposium/ahp/`;
- retain bounded, redacted projection diagnostics as opt-in observability.

The runtime is always enabled. `RenderStream` remains only as an internal
persisted transcript/event source; it has no webview sinks and performs no UI
reconstruction.

### Phase 2 — AHP WebSocket endpoint

The opt-in Bridge exposes `/ahp` as its only remote chat state/action transport:

- authenticate during the WebSocket upgrade with the existing Bridge token;
- implement `initialize`, `ping`, `reconnect`, `subscribe`, `unsubscribe`,
  `listSessions`, `createSession`, `disposeSession` and `dispatchAction`;
- negotiate only versions explicitly supported by the host;
- apply `allowedHosts`, `allowedRoots` and forced session permission before any
  session creation or filesystem operation;
- validate client-dispatchable action types and channel ownership;
- cap frame size, subscriptions per client, replay requests and connection rate;
- never place access tokens, tool secrets or raw environment values in shared
  state, replay logs or telemetry.

Supporting HTTP routes (`/health`, resources, backends and diagnostics) remain;
the former `/sessions`, `/send`, `/interrupt` and `/follow` chat facade was
removed after the compatibility window.

### Phase 3 — PWA as the first AHP client

The PWA is the safest first consumer because it already uses the remote Bridge:

- bundle the official TypeScript client and WebSocket transport;
- mirror AHP state and render `ChatState` directly;
- use root/session/chat subscriptions and write-ahead actions;
- test disconnect/reconnect, concurrent viewers and first-writer-wins approval.

### Phase 4 — editor and sidebar clients

The webview uses an in-process MessagePort-style AHP transport and the same
reducers as the PWA. Editor and sidebar are ordinary state clients, not sinks
bound to `ChatController`. Non-chat surface commands still use the closed
`HostToWebview`/`WebviewToHost` protocol.

### Phase 5 — advanced channels

Adopt optional surfaces only after the core is interoperable:

- changesets for diff review/approve/reject;
- terminals with explicit claims and resize/input flow;
- resource reads/writes and resource watches;
- customizations for Symposium agents, skills, instructions and MCP servers;
- client-provided tools/active clients;
- OTLP telemetry channels.

## Delivery record

The 2026-08-09 implementation completed the host, projections, persistence,
authenticated transports and all three clients:

1. [Host runtime and channel models](activities/20260809201446-ahp-host-runtime-and-channel-models.md)
2. [Normalized agent-event projection](activities/20260809201447-ahp-agent-event-projection.md)
3. [Shadow projection and parity diagnostics](activities/20260809201448-ahp-shadow-projection.md)
4. [Persistence and restart recovery](activities/20260809201449-ahp-persistence-and-restart.md)
5. [Authenticated WebSocket transport](activities/20260809201450-ahp-authenticated-websocket.md)
6. [PWA client migration](activities/20260809202643-ahp-pwa-client-migration.md)
7. [Editor and sidebar migration](activities/20260809210800-ahp-editor-sidebar-migration.md)

Optional capability packages are also implemented behind explicit host
enablement and advertised capability gates:

- [Changeset channel](activities/20260809210801-ahp-changeset-channel.md)
- [Terminal channel](activities/20260809210803-ahp-terminal-channel.md)
- [Resource and attachment channels](activities/20260809210802-ahp-resource-channel.md)
- [Customization channels](activities/20260809210804-ahp-customization-channels.md)
- [Client-provided tools](activities/20260809210805-ahp-client-tools.md)
- [Telemetry measurements](activities/20260809210806-ahp-telemetry.md)

Legacy transport retirement completed after the editor/sidebar and PWA clients
remained released across the required compatibility window. See the completed
[retirement plan](plans/PLAN-AHP-legacy-transport-retirement.md).

### State-authority hardening — 2026-08-11

Message submission is now a command, `symposium/messageSubmitted`, rather than
an optimistic `chat/pendingMessageSet` mutation. MessagePort and WebSocket/PWA
clients share one command builder, the echoed envelope provides the correlation
tuple `(id, mode, origin.clientId, origin.clientSeq, serverSeq)`, and only the
host's `ChatQueue` projection may emit pending-message state actions. The old
client spelling is no longer accepted; `chat/pendingMessageSet` is strictly a
host projection action.

Restart restoration also distinguishes durable from process-local state:

| Preserved | Cleared on host restart |
|---|---|
| completed turns, draft, genuine projected queue | active turn and activity text |
| session metadata and archive/read flags | busy/input-needed status |
| model/message metadata | stale active clients and approval requests |

Presentation now consumes `ChatState` and accepted action envelopes directly.
The AHP-to-legacy view adapter and the optional shadow runtime were removed;
projection is the mandatory producer boundary above existing controllers.

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

## Operational validation

- Root, session and chat reducers cover text, tools, approval, cancellation,
  queue and error flows for all built-in adapters.
- Projection tests replay the same conversation state from Claude, Codex,
  Copilot and OpenAI fixture events.
- A 10,000-action stress test preserves ordering and bounded memory.
- Restart restores snapshots and replays the retained tail.
- Projection diagnostics show no transcript/status divergence during manual
  Extension Host validation.
