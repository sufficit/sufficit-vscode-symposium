# AHP resource and attachment channel

Status: **Completed**
Date: 2026-08-09

## Activity

Implemented capability-gated, opaque AHP references for allowed workspace
resources and composer attachments.

## Delivered

- stable opaque resource references instead of durable unrestricted paths;
- per-session/chat ownership checks;
- realpath root containment and symlink escape prevention;
- protected-resource authentication gate for secret-bearing paths;
- bounded reads, writes and watches with disposal on session removal;
- snapshots containing metadata only, never credentials or file contents;
- independent capability advertisement and rollback by disabling the feature.

## Validation

Path traversal, symlink, ownership, protected-resource, redaction, read-size and
session-disposal tests pass with the complete project suite.

## Outcome

Resource access is reusable across adapters while remaining host-controlled,
bounded and scoped to the originating conversation.
