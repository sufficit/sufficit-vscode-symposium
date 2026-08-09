# PLAN — AHP telemetry measurements

**Created:** 2026-08-09
**Status:** pending
**Origin:** optional AHP channel split by the 2026-08-09 audit.
**Depends on:** stable core AHP lifecycle and explicit telemetry policy.

## Outcome

Emit OTLP-compatible operational measurements for AHP sessions and transports
without placing telemetry in durable state or replay.

## Work

- Define bounded metrics for lifecycle latency, reconnect, replay, projection
  mismatch, backpressure and rejection reasons.
- Keep measurements ephemeral and outside channel snapshots/action tails.
- Apply consent, sampling and redaction policy before export.
- Exclude prompt text, tool payloads, file content, credentials and user secrets.
- Bound label cardinality and export queues.
- Advertise telemetry capability only when enabled by policy.

## Acceptance criteria

- No telemetry event is required to reconstruct visible client state.
- Disabled telemetry emits and exports nothing.
- Labels contain no stable secret or unbounded user-controlled value.
- Export failure cannot block sessions or AHP clients.

## Validation and rollback

Add consent, redaction, cardinality, failure-isolation and disabled-mode tests;
run `npm run verify`. Disable the telemetry capability/exporter independently.
