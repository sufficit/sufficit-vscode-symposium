# AHP normalized agent-event projection

Status: **Completed**
Date: 2026-08-09

## Activity

Mapped Symposium's normalized adapter events and controller state into AHP
session/chat actions without leaking provider-specific payloads.

## Delivered

- turn, text, reasoning, tool, approval, usage, error, cancellation and
  completion projections;
- queue, title, archive and chat-summary projections;
- stable correlation for logical turns, response parts and tool calls;
- allowlisted metadata and protected-field exclusion;
- equivalent Claude/Codex/OpenAI fixture tests that reduce to the same state.

## Validation

Projection tests distinguish failed and cancelled turns, retain approval
correlation and prove backend-neutral transcript equivalence.

## Outcome

Adapters continue emitting the existing `AgentEvent` contract while AHP receives
one deterministic semantic stream.
