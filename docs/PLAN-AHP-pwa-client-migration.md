# PLAN — migrate the PWA to an AHP client

**Created:** 2026-08-09
**Status:** pending
**Origin:** remaining AHP PWA migration identified by the 2026-08-09 audit.
**Depends on:** authenticated WebSocket transport and shadow parity.

## Outcome

Make the PWA the first production AHP client while retaining REST+SSE as a
temporary fallback.

## Work

- Bundle the official `AhpClient`, `AhpStateMirror` and WebSocket transport.
- Add shared browser-safe AHP client state/selectors under `src/ahp/client/`.
- Render root/session/chat state from the mirror.
- Use client action identifiers for optimistic send, queue and approval state.
- Present connecting, reconnecting, caught-up and failed states in accessible
  text as well as color.
- Keep the REST+SSE implementation behind a temporary fallback setting.
- Handle disconnect during stream, duplicate delivery and concurrent viewers.

## Acceptance criteria

- Create/open/send/cancel/queue/approve and transcript display reach parity.
- Reconnect catches up without duplicate text, tools or queued actions.
- Two PWA viewers reconcile conflicting operations to host state.
- Keyboard, focus, screen-reader status and reduced motion remain valid.

## Validation

Add browser/integration tests around the shared mirror and transport plus PWA
smokes for interruption and concurrent viewers; run `npm run verify:package`.

## Rollback

Switch the PWA transport setting back to REST+SSE while retaining host shadow
projection for diagnosis.
