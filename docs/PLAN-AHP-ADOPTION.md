# AHP adoption implementation plan

Status: Phase 0 complete; Phases 1–5 pending.

Protocol baseline: `@microsoft/agent-host-protocol@0.6.0` (exact-pinned).

This is the execution plan for the architecture described in
[AHP-ADOPTION.md](AHP-ADOPTION.md). It records the remaining work, intended
code boundaries, dependencies, acceptance criteria, validation and rollback
points. It should be updated as each milestone lands.

## Outcome

Make Symposium the authoritative AHP host for a session that can be observed
and controlled consistently from the VS Code webview, PWA and future clients,
without coupling AHP to any one agent backend.

The existing `AgentAdapter` interface remains the downstream integration
boundary. AHP becomes the client-facing state and synchronization boundary.

## Non-goals

- Replacing Claude, Codex, Copilot or OpenAI adapter protocols with AHP.
- Requiring ACP before the host migration can proceed.
- Removing the current HTTP+SSE Bridge before an AHP client reaches parity.
- Publishing an unauthenticated AHP endpoint.
- Persisting secrets, raw environment values or provider credentials in AHP
  state or replay logs.
- Implementing every optional AHP channel before core session/chat
  interoperability is proven.

## Current baseline

Phase 0 established the transport-independent channel primitive in
`src/ahp/channelStore.ts`:

- one monotonic server sequence across all channels;
- pure channel reducers and host-authoritative snapshots;
- bounded reconnect replay with snapshot fallback;
- accepted and rejected client-action echoes;
- isolated subscribers and explicit missing-channel reporting;
- type-level alignment with the exact-pinned official SDK;
- unit coverage in `src/test/ahpChannelStore.test.ts`.

The foundation is intentionally disconnected from production sessions.
`ChatController`, `RenderStream`, the existing webview protocol and the remote
Bridge remain the live product path.

## Cross-phase invariants

Every implementation phase must preserve these rules:

1. The host is the only authority for durable shared state.
2. `serverSeq` is unique and monotonically increasing across all channels.
3. A client action is accepted exactly once or echoed as rejected; clients can
   always reconcile optimistic state.
4. Backend-specific payloads are normalized before reaching AHP state.
5. Stable Symposium UUIDs identify sessions and chats. Temporary UI keys and
   provider resume identifiers never become public channel identity.
6. Snapshots plus the retained action tail reconstruct durable visible state.
7. Notifications are ephemeral and are not required for reconstruction.
8. Capabilities gate behavior. Provider-name checks do not.
9. Remote AHP inherits or strengthens every current Bridge security boundary.
10. No migration phase makes two independent components authoritative for the
    same state.

## Milestone 1 — host runtime and shadow projection

Objective: prove that normalized Symposium behavior can reconstruct equivalent
AHP state without changing what users see.

### 1.1 Define host-owned channel models

Target files:

- `src/ahp/hostRuntime.ts`
- `src/ahp/channelModels.ts`
- `src/ahp/channelUris.ts`
- `src/ahp/index.ts`
- `src/test/ahpHostRuntime.test.ts`

Work:

- Define root state containing available agents, capabilities and live session
  references.
- Define session state containing lifecycle, title, active/default chat,
  permission policy and queue summary.
- Define chat state for ordered turns, messages, content parts, tool calls,
  approvals, activity and usage.
- Provide URI constructors/parsers that accept only stable UUID-backed
  identities and reject malformed or cross-kind URIs.
- Wrap `AhpChannelStore` in an `AhpHostRuntime` that atomically registers and
  disposes the root/session/chat channel set.
- Keep reducers pure and testable without VS Code or a network transport.

Acceptance:

- Creating one session produces exactly one root reference, one session channel
  and one default chat channel.
- Disposing it updates the root and removes inaccessible channels.
- Invalid URIs and duplicate registration fail deterministically.
- Reducer replay produces the same state as incremental dispatch.

### 1.2 Project normalized agent events

Target files:

- `src/ahp/projectAgentEvent.ts`
- `src/ahp/projectControllerState.ts`
- `src/adapters/types.ts` only if a missing normalized field is unavoidable
- `src/test/ahpProjection.test.ts`

Work:

- Map text deltas/final text, reasoning, tool start/result, approval requests,
  usage, errors, cancellation and completion to official action shapes.
- Model one user dispatch and its assistant work as an explicit turn
  lifecycle.
- Convert adapter-specific metadata into optional `_meta` fields only when it
  adds diagnostic value.
- Treat unknown normalized events as observable projection diagnostics, not
  fatal session errors.
- Add fixtures representing Claude, Codex, Copilot and OpenAI event streams.

Acceptance:

- All built-in adapter fixtures yield the same backend-neutral transcript for
  equivalent conversations.
- Interrupted, failed and cancelled turns finish in distinct, valid states.
- Tool and approval correlation remains stable through replay.
- No provider credential or environment value appears in serialized state.

### 1.3 Integrate in shadow mode

Target files:

- `src/sessions/runtime.ts`
- `src/ui/chatController.ts`
- `src/ui/controllerQueue.ts`
- `src/ui/renderStream.ts`
- `src/extension.ts`
- `package.json` for an opt-in diagnostic setting

Work:

- Own one `AhpHostRuntime` beside `LiveSessions`.
- Register/dispose projected state with controller lifecycle.
- Dispatch projected actions from normalized controller events and state
  transitions.
- Keep `RenderStream` as the sole UI source.
- Add structured mismatch counters comparing transcript, status, queue and
  approval state after each completed turn.
- Add a developer-only command or output-channel diagnostic dump with secrets
  redacted.

Acceptance:

- Enabling shadow mode does not alter current webview messages or Bridge
  behavior.
- A full manual session on every backend reports no transcript/status
  divergence.
- A 10,000-action stress test preserves sequence order and bounded replay
  memory.

Rollback: disable shadow projection and leave the runtime unconstructed. No
stored production state or client contract depends on this milestone.

## Milestone 2 — persistence and reconnect durability

Objective: survive extension restart without allowing stale actions to be
mistaken for current authority.

Target files:

- `src/ahp/persistence.ts`
- `src/ahp/hostRuntime.ts`
- `src/test/ahpPersistence.test.ts`
- extension storage initialization in `src/extension.ts`

Work:

- Store versioned snapshots and a bounded action tail in the extension global
  storage directory under `ahp/`.
- Write through a temporary file and atomic rename.
- Persist the advertised AHP version and local schema version.
- Validate size, schema, URI ownership and sequence monotonicity while loading.
- Quarantine unreadable/incompatible files rather than partially applying
  them.
- Compact persistence after a configurable action count and on clean shutdown.
- Redact protected resources and `_meta` keys denied by policy.

Acceptance:

- Restart restores all durable visible state and resumes with a sequence higher
  than every restored action.
- A truncated/corrupt file cannot prevent extension activation.
- An unsupported schema falls back to a clean snapshot with a clear diagnostic.
- Persistence stays within explicit per-session and total byte limits.

Rollback: ignore persisted AHP data after renaming the store directory for
diagnosis. Existing Symposium transcript persistence remains independent.

## Milestone 3 — authenticated AHP WebSocket transport

Objective: expose the same authoritative runtime to remote clients while
retaining the existing Bridge API.

Target files:

- `src/api/bridge.ts`
- `src/api/bridgeAuth.ts`
- `src/api/bridgePolicy.ts`
- `src/ahp/webSocketServer.ts`
- `src/ahp/wireProtocol.ts`
- `src/test/ahpWebSocket.test.ts`
- `package.json` for endpoint and limit settings

Work:

- Add an opt-in `/ahp` WebSocket upgrade route to the existing Bridge server.
- Authenticate before upgrade using the Bridge token without accepting it in a
  query string.
- Implement `initialize`, version/capability negotiation, `ping`, reconnect,
  subscribe/unsubscribe, session list/create/dispose and action dispatch.
- Reject unsupported versions and unadvertised commands with protocol errors.
- Enforce host, workspace root, permission-mode and local-tool policy before
  creating a session or performing an action.
- Validate every inbound frame before dispatch.
- Limit frame bytes, connections, subscriptions, replay distance, queued
  writes, malformed frames and connection rate.
- Apply backpressure and close slow clients without blocking other subscribers.
- Log connection identity and rejection reason without logging payload secrets.

Acceptance:

- Two authenticated clients observe identical global action order.
- Reconnect from a retained sequence replays only the missing tail.
- Reconnect behind the retention window returns authoritative snapshots.
- Unauthorized upgrade, over-limit frames and invalid client actions are
  rejected in tests.
- Existing REST+SSE Bridge tests and PWA continue to pass unchanged.
- Interoperability is manually verified with an independent AHP client.

Rollback: disable the AHP endpoint setting. REST+SSE remains available against
the existing controller path until Milestone 4 is proven.

## Milestone 4 — migrate the PWA

Objective: make the PWA the first production client of the AHP runtime.

Target files:

- `src/ui/webview/pwaShim.ts`
- `src/pwa/`
- shared client state/reducer modules under `src/ahp/client/`
- browser bundle configuration and PWA tests

Work:

- Bundle the official `AhpClient`, `AhpStateMirror` and WebSocket transport.
- Render session/chat state from the mirror rather than reconstructing it from
  Bridge-specific events.
- Use client action identifiers for optimistic send/queue/approval state.
- Expose connecting, reconnecting, caught-up and failed states accessibly in
  text as well as color.
- Preserve the current REST+SSE implementation behind a temporary fallback
  setting.
- Exercise disconnect during streaming, concurrent viewers, duplicate action
  delivery and first-writer-wins approval.

Acceptance:

- Feature parity for create/open/send/cancel/queue/approve and transcript
  display.
- A network interruption catches up without duplicated text or tools.
- Two PWA clients can watch one session; conflicting operations reconcile to
  host state.
- Keyboard, focus, screen-reader status and reduced-motion behavior remain
  valid.

Rollback: switch the PWA transport setting back to REST+SSE. The host runtime
continues shadow projection for diagnosis.

## Milestone 5 — migrate editor and sidebar webviews

Objective: make local surfaces ordinary AHP clients of the same host.

Target files:

- `src/ui/chatSurface.ts`
- `src/ui/chatPanel.ts`
- `src/ui/chatView.ts`
- `src/ui/protocol.ts`
- `src/ui/surfaceMessages.ts`
- `src/ui/renderStream.ts`
- `src/ahp/messagePortTransport.ts`
- shared webview client state under `src/ahp/client/`

Work:

- Add an in-process transport over VS Code webview messages with the same AHP
  semantics as WebSocket.
- Reuse the PWA reducer/state mirror and UI selectors.
- Replace direct controller attachment with root/session/chat subscriptions.
- Move send, cancel, queue, approval and session operations to AHP dispatch.
- Remove legacy host-to-webview message variants only after telemetry and tests
  show no remaining consumers.
- Retain a release-scoped compatibility switch during rollout.

Acceptance:

- Opening the same session in editor, sidebar and PWA shows one consistent
  state.
- Reloading any surface resumes from sequence or snapshot without duplication.
- No UI surface can overwrite host state with a stale local snapshot.
- Legacy `RenderStream` replay is no longer required by migrated surfaces.

Rollback: restore direct controller attachment with the compatibility switch.
Do not remove the old protocol until at least one stable release has shipped.

## Milestone 6 — optional AHP channels

Objective: adopt advanced protocol surfaces independently after core stability.

Work packages:

- **Changesets:** project `src/ui/changedFiles*.ts` into reviewable changeset
  channels with explicit apply/reject authority.
- **Terminals:** expose terminal output, claims, resize and input without
  leaking shell environment data.
- **Resources:** map attachments and allowed workspace resources with existing
  `allowedRoots` enforcement.
- **Customizations:** advertise agents, skills, instructions and MCP servers as
  capabilities, with protected-resource authentication where required.
- **Client tools:** register client-provided tools with explicit ownership and
  disconnect cleanup.
- **Telemetry:** emit OTLP-compatible measurements without putting telemetry in
  durable channel replay.

Each work package requires its own capability flag, threat model, conformance
tests and rollback switch. None blocks another.

## Test strategy

### Unit

- Reducer determinism, action rejection, URI validation and sequence ordering.
- Projection fixtures for every normalized `AgentEvent`.
- Persistence corruption, version migration and redaction.
- Wire schema validation and policy enforcement.

### Integration

- Controller lifecycle to AHP channel lifecycle.
- Concurrent clients and reconnect at every stream boundary.
- Approval races, cancellation races and queued-message promotion.
- Extension restart with active and completed sessions.

### Performance

- 10,000 actions in one session with bounded retained memory.
- Multiple active sessions sharing one global sequence.
- Slow subscriber isolation and WebSocket backpressure.
- Snapshot serialization/deserialization within explicit latency and size
  budgets.

### Product validation

- Claude Code, Codex CLI, Copilot CLI and OpenAI-compatible smoke sessions.
- Editor, sidebar and PWA parity.
- Keyboard-only and screen-reader pass for connection/reconciliation states.
- Independent client conformance check before advertising remote AHP support.

Commands expected before every milestone merge:

```bash
npm run format:check
npm run lint
npm test
npm run compile
```

Add focused tests to the default `npm test` suite; do not rely only on manual
validation.

## Security checklist

- Authentication occurs before subscription or state disclosure.
- AHP access tokens never appear in URLs.
- Session creation always enforces configured roots and permission mode.
- Client-dispatchable actions use an allowlist by channel type and capability.
- Frame, replay, subscription and persistence sizes have hard bounds.
- Logs and diagnostics redact credentials, environment values and protected
  resource responses.
- Approval authority is host-resolved and deterministic under concurrency.
- Terminal and resource channels require explicit capability plus policy.
- Persisted state has restrictive filesystem permissions.

## Main risks and mitigations

| Risk | Mitigation |
|---|---|
| Draft protocol changes | Exact pin, conformance suite and deliberate upgrade checklist. |
| Two competing state authorities | Shadow first; cut each surface over atomically; keep host authoritative. |
| Projection loses backend nuance | Normalize required semantics; preserve optional diagnostics in `_meta`. |
| Replay memory or disk growth | Bounded tails, periodic snapshots and hard per-session/total limits. |
| Remote endpoint broadens attack surface | Opt-in endpoint, pre-upgrade auth, policy reuse, validation and rate limits. |
| UI regressions during migration | PWA first, shared client reducer, compatibility switches and parity tests. |
| Slow client blocks sessions | Per-client bounded queues, backpressure and disconnect policy. |

## Suggested delivery slices

1. Host models, URIs and reducers.
2. Adapter-event projection fixtures.
3. Shadow-mode runtime and divergence diagnostics.
4. Durable snapshots/action tail.
5. Authenticated WebSocket negotiation and read-only subscriptions.
6. Remote action dispatch and policy enforcement.
7. PWA AHP client behind fallback.
8. Editor/sidebar in-process AHP client.
9. Retire legacy replay after one stable release.
10. Add optional channels as independent features.

Each slice should be independently reviewable, testable and reversible. Avoid a
single change that combines protocol transport, UI migration and deletion of
the compatibility path.

## Definition of done

AHP core adoption is complete when:

- the host runtime is the sole authority for root, session and chat state;
- all built-in adapters pass the same projection contract;
- WebSocket and in-process clients use negotiated AHP capabilities;
- editor, sidebar and PWA reconnect without transcript duplication or lost
  operations;
- persistence and replay survive restart and retention rollover;
- the legacy REST+SSE facade, if retained, reads/writes the same host runtime;
- security, concurrency, accessibility and performance acceptance tests pass;
- an independent AHP client interoperates with the advertised version;
- README and architecture documentation reflect the shipped behavior.

