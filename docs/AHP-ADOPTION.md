# Agent Host Protocol adoption

Status: incremental adoption approved; only the Phase 0 foundation is implemented.

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

## Why it improves Symposium

The current architecture already has a host-like runtime, but synchronization
is expressed as Symposium-specific render messages:

- `ChatController` is authoritative for a live session.
- `RenderStream` replays at most 5,000 UI messages to attached observers.
- the webview protocol and the HTTP+SSE Bridge are separate client contracts;
- reconnect means replaying a render log, with no global ordering across
  sessions;
- queue, approval, terminal and changed-file state use different ad-hoc shapes.

AHP gives those concepts one contract:

| Symposium today | AHP target |
|---|---|
| adapters list and model pickers | `ahp-root://` agents |
| `LiveSessions` entry | `ahp-session:/<uuid>` |
| one `ChatController` conversation | default `ahp-chat:/<uuid>` |
| render history/live events | chat snapshot + ordered actions |
| `busy`, errors and notices | session/chat status and activity |
| `ChatQueue` | `chat/pendingMessage*` |
| approval request/response | tool-call ready/confirmed lifecycle |
| changed files and approve/reject | changeset channel and operations |
| terminal-backed sessions | terminal channels |
| local resources and attachments | `resource*` commands and content refs |
| Bridge bearer token | transport auth |
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

## Incremental delivery

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

It is deliberately not wired to the UI yet. That keeps the existing product
stable while the event projection is tested in shadow mode.

### Phase 1 — Symposium-to-AHP projection

Add an `AhpHostRuntime` beside `LiveSessions` and project existing normalized
events into official state/actions:

- create root, session and default-chat states when a controller is registered;
- dispatch `chat/turnStarted` before calling `AgentSession.send`;
- map text, thinking, tools, approvals, usage, errors and completion into chat
  actions;
- mirror title, status, queue and archive changes into session/chat state;
- persist periodic channel snapshots plus the action tail under
  `~/.symposium/ahp/`;
- compare the projected transcript with `RenderStream` in tests and diagnostics.

`RenderStream` stays the UI path during this phase. Any projection mismatch is
observable without breaking a conversation.

### Phase 2 — AHP WebSocket endpoint

Extend the opt-in Bridge with `/ahp` while retaining the existing REST+SSE API:

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

The HTTP Bridge remains a compatibility facade over the same host runtime,
instead of owning a second state model.

### Phase 3 — PWA as the first AHP client

The PWA is the safest first consumer because it already uses the remote Bridge:

- bundle the official TypeScript client and WebSocket transport;
- render from `AhpStateMirror`;
- use root/session/chat subscriptions and write-ahead actions;
- keep the current REST+SSE adapter as a temporary fallback;
- test disconnect/reconnect, concurrent viewers and first-writer-wins approval.

### Phase 4 — editor and sidebar clients

Move the webview to an in-process AHP transport (for example `MessagePort`) and
share the official reducer/state mirror with the PWA. The editor and sidebar
then become ordinary clients of the same state rather than special sinks bound
directly to `ChatController`.

This phase is also the right boundary for retiring most of the permissive
`HostToWebview` message bag and the replay-specific parts of `RenderStream`.

### Phase 5 — advanced channels

Adopt optional surfaces only after the core is interoperable:

- changesets for diff review/approve/reject;
- terminals with explicit claims and resize/input flow;
- resource reads/writes and resource watches;
- customizations for Symposium agents, skills, instructions and MCP servers;
- client-provided tools/active clients;
- OTLP telemetry channels.

## Delivery record and remaining gate

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

The only open delivery boundary is [legacy transport
retirement](plans/PLAN-AHP-legacy-transport-retirement.md). Its own safety gate
requires the PWA, editor and sidebar AHP clients to remain stable for at least
one released version before compatibility paths and rollback switches are
removed.

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

## Phase 1 completion criteria

- Root, session and chat reducers cover text, tools, approval, cancellation,
  queue and error flows for all built-in adapters.
- Projection tests replay the same conversation state from Claude, Codex,
  Copilot and OpenAI fixture events.
- A 10,000-action stress test preserves ordering and bounded memory.
- Restart restores snapshots and replays the retained tail.
- Shadow-mode diagnostics show no transcript/status divergence during manual
  Extension Host validation.
