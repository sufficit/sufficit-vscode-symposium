# AHP shadow projection and parity diagnostics

Status: **Completed**
Date: 2026-08-09

## Activity

Connected the AHP runtime beside live controllers as an opt-in shadow, leaving
RenderStream and every production UI consumer unchanged.

## Delivered

- lifecycle synchronization against the public live-session facade;
- replay-follow projection for user, event and queue messages;
- bounded counters for transcript, status, queue, approval and projection drift;
- redacted developer diagnostics and runtime enable/disable settings;
- safe attach/dispose behavior and persisted state integration.

## Validation

Integration fixtures show no transcript/status/queue divergence. A 10,000-event
stress test preserves global ordering while retaining only the configured tail.

## Outcome

AHP parity can be measured in real sessions without changing current sidebar,
editor, PWA or REST/SSE behavior.
