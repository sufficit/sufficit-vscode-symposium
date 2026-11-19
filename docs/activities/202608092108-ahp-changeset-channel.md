# AHP changeset channel

Status: **Completed**
Date: 2026-08-09

## Activity

Implemented an optional, capability-advertised AHP channel for host-owned
changed-file review decisions.

## Delivered

- stable session/chat/turn correlation and bounded path-only file metadata;
- deterministic versioning, stale-decision rejection and idempotent repeats;
- host callback as the sole apply/reject authority;
- configured-root containment with traversal, realpath and symlink checks;
- secret-bearing path protection and exclusion of file contents from state;
- root/session capability advertisement only when enabled.

## Validation

Tests cover ordering through the shared runtime, allowed-root policy, symlink
escape, content exclusion, stale conflicts and idempotent decisions. The full
project suite passes.

## Outcome

Hosts can opt into changeset state and decisions without coupling clients to a
provider name or exposing unrestricted workspace content.
