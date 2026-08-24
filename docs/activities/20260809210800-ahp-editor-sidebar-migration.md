# Editor and sidebar migration to AHP

Status: **Completed**
Date: 2026-08-09

## Activity

Made the editor and sidebar webviews ordinary clients of the same
host-authoritative AHP state used by the PWA.

## Delivered

- race-free `MessagePort` transport over VS Code webview messages;
- root, session and chat snapshot reconciliation before buffered live actions;
- shared AHP reducer/state mirror and temporary legacy-view selectors;
- send, cancel, continuation, queue and approval writes routed through host
  authority with client sequence and rejection echo;
- generation fencing so a stale or replaced surface cannot mutate current state;
- accessible connecting, reconciling, synchronized and failed status;
- `symposium.chat.transport` release-scoped `ahp`/`legacy` rollback switch;
- live-only render observer retained for local side effects, not transcript
  reconstruction.

## Validation

Message-port, stale-generation, duplicate-delivery, snapshot, DOM reconciliation,
composer isolation and central-editor/sidebar behavior tests pass as part of
`npm test` and `npm run compile`.

## Outcome

PWA, editor and sidebar now converge on the same ordered AHP state. Legacy
message variants remain only as a compatibility renderer until the separate
post-release retirement gate is satisfied.
