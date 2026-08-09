# PLAN — AHP shadow projection and parity diagnostics

**Created:** 2026-08-09
**Status:** pending
**Origin:** remaining AHP shadow-integration work identified by the 2026-08-09 audit.
**Depends on:** host runtime/models and normalized event projection plans.

## Outcome

Run AHP state beside the current live path and prove parity without changing
what the webview, PWA or Bridge consumes.

## Work

- Own one `AhpHostRuntime` beside `LiveSessions`.
- Register and dispose projected channels with controller lifecycle.
- Feed normalized controller events and queue/state transitions into AHP.
- Keep `RenderStream` as the sole production UI source.
- Compare transcript, lifecycle status, queue and approval state after turns.
- Add bounded structured mismatch counters and a developer-only redacted dump.
- Add an opt-in diagnostic setting; disabled means no runtime construction.

## Acceptance criteria

- Shadow mode changes no existing webview or REST+SSE Bridge message.
- Automated controller fixtures show no transcript/status divergence.
- Manual smoke sessions cover every built-in adapter without divergence.
- A 10,000-action stress test preserves global ordering and bounded replay.
- Diagnostics redact secrets and remain bounded.

## Validation

Add controller-to-AHP integration and stress tests, exercise all built-in
adapters, and run `npm run verify:package`.

## Rollback

Disable the diagnostic setting and leave `AhpHostRuntime` unconstructed. No
stored production contract may depend on shadow state.
