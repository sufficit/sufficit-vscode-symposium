# AHP terminal channel

Status: **Completed**
Date: 2026-08-09

## Activity

Implemented the optional AHP terminal state and control boundary with explicit
input ownership.

## Delivered

- bounded terminal output snapshots and ordered runtime actions;
- exclusive client claim/release for input;
- permission callback before input reaches the terminal;
- input-size, resize-rate and output-memory limits;
- credential/environment redaction before durable state;
- disconnect cleanup that releases claims safely;
- capability advertisement only when a host terminal binding is enabled.

## Validation

Tests cover claim races, ownership denial, bounded output, redaction, input
limits and disconnect cleanup. Runtime reconnect/backpressure behavior is
covered by the shared AHP transport tests.

## Outcome

Terminal-capable hosts can expose coherent output and controlled input without
leaking raw environment values or allowing one viewer to block another.
