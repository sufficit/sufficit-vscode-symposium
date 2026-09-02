# Visible automatic retry after agent progress

Date: 2026-09-02
Release: 2026.902.4
Feature: `symposium.recovery` 1.2.2

## Symptom

An OpenAI/Sufficit AI turn could run tools and emit progress for several
minutes, then end with a retryable HTTP 503 without scheduling automatic
recovery. The user saw only the final error card.

## Evidence

The affected code-server workspace was still running extension version
2026.902.1 even though 2026.902.3 was installed. Its persisted AHP turn ended
with HTTP 503 after 1,028 seconds and contained alternating markdown and tool
calls. No `[retry]` scheduling event was logged.

The controller also treated thinking and any progress text as an unconditional
replay blocker. This silently overrode the enabled-by-default
`transientRetryAfterToolActivity` preference whenever an agent narrated work
around its tools.

## Resolution

- Thinking alone no longer blocks recovery.
- When tool activity occurred, `transientRetryAfterToolActivity` now decides
  whether the same logical intent can continue, even if progress text was
  emitted around the tool calls.
- Standalone assistant output without tool activity still prevents replay.
- Approval requests and resolutions remain non-replayable.
- The existing recovery card remains UI-only and shows the attempt counter and
  countdown before the retry is dispatched.

## Verification

Regression tests cover thinking-only recovery, tool activity interleaved with
visible progress, the opt-out setting, standalone assistant output, bounded
retry attempts and UI-only recovery status.
