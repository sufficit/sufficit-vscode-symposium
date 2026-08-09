# PLAN — project normalized agent events into AHP

**Created:** 2026-08-09
**Status:** pending
**Origin:** remaining AHP event-projection work identified by the 2026-08-09 audit.
**Depends on:** `PLAN-AHP-host-runtime-and-channel-models.md`.

## Outcome

Translate normalized Symposium controller events into backend-neutral AHP chat
and session actions without exposing provider protocols or credentials.

## Work

- Add `src/ahp/projectAgentEvent.ts` and
  `src/ahp/projectControllerState.ts`.
- Model one user dispatch and its assistant work as an explicit turn lifecycle.
- Project text, reasoning, tools, approvals, usage, errors, cancellation and
  completion into official action shapes.
- Map title, status, queue and permission state into session actions.
- Preserve diagnostic provider metadata only in optional redacted `_meta`.
- Treat unknown normalized events as projection diagnostics, not fatal errors.
- Add equivalent Claude, Codex, Copilot and OpenAI fixtures.

## Acceptance criteria

- Equivalent backend fixtures produce the same visible transcript and state.
- Completed, interrupted, failed and cancelled turns remain distinct.
- Tool/approval identifiers remain correlated through replay.
- Serialized snapshots/actions contain no credential or environment secret.
- Adapter-specific event shapes do not escape the projection boundary.

## Validation

Add `src/test/ahpProjection.test.ts`, including redaction and replay cases, then
run `npm run verify`.

## Rollback

Remove the projection modules. No production controller consumes them until
the shadow-projection plan is enabled.
