# PLAN — AHP host runtime and channel models

**Created:** 2026-08-09
**Status:** pending
**Origin:** remaining AHP host-model work identified by the 2026-08-09 audit.
**Depends on:** completed Phase 0 channel foundation.

## Outcome

Provide a host-owned root/session/chat state model and lifecycle runtime above
`AhpStateStore`, without connecting it to production controllers yet.

## Work

- Add `src/ahp/channelModels.ts` for backend-neutral root, session and chat
  state, including capabilities, lifecycle, title, active/default chat,
  permission policy, queue summary, turns, tools, approvals and usage.
- Add `src/ahp/channelUris.ts` with constructors/parsers that accept only stable
  UUID-backed identities and reject malformed, temporary or cross-kind URIs.
- Add `src/ahp/hostRuntime.ts` to atomically register and dispose one root
  reference, session channel and default chat channel.
- Export the public AHP host boundary from `src/ahp/index.ts`.
- Keep reducers pure and independent from VS Code, adapters and transports.

## Acceptance criteria

- Registering one session creates exactly one root reference, session channel
  and default chat channel.
- Disposal updates the root and makes removed channels inaccessible.
- Invalid URIs, duplicate registration and partial lifecycle failures are
  deterministic.
- Incremental dispatch and replay reduce to identical snapshots.
- Stable Symposium UUIDs are the only public session/chat identity.

## Validation

Add `src/test/ahpHostRuntime.test.ts` for lifecycle, URI validation, replay
determinism and failure atomicity, then run `npm run verify`.

## Rollback

Remove the unconnected runtime and models. The existing controller and
`RenderStream` path remains authoritative.
