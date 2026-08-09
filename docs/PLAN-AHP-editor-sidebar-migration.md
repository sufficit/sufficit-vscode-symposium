# PLAN — migrate editor and sidebar webviews to AHP

**Created:** 2026-08-09
**Status:** pending
**Origin:** remaining local-surface migration identified by the 2026-08-09 audit.
**Depends on:** proven PWA AHP client and shared AHP client state.

## Outcome

Make editor and sidebar ordinary clients of the same host-authoritative state
used by the PWA.

## Work

- Add `src/ahp/messagePortTransport.ts` over VS Code webview messages.
- Reuse the shared AHP state mirror, reducers and selectors.
- Replace direct controller attachment with root/session/chat subscriptions.
- Dispatch send, cancel, queue, approval and session operations through AHP.
- Add accessible connection/reconciliation status to local surfaces.
- Retain a release-scoped compatibility switch.
- Keep legacy message variants while any consumer still requires them.

## Acceptance criteria

- Editor, sidebar and PWA show one consistent session state.
- Reload resumes from sequence or snapshot without duplication.
- A stale surface cannot overwrite authoritative host state.
- Migrated surfaces no longer require `RenderStream` replay.
- Existing central-tab/sidebar placement behavior remains correct.

## Validation

Add message-port contract, DOM, reconnect, multi-surface and stale-client tests;
exercise editor/sidebar/PWA parity and run `npm run verify:package`.

## Rollback

Restore direct controller attachment through the compatibility switch. Keep the
legacy protocol until the separate retirement plan is complete.
