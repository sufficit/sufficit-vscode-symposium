# PLAN — AHP resource and attachment channels

**Created:** 2026-08-09
**Status:** pending
**Origin:** optional AHP channel split by the 2026-08-09 audit.
**Depends on:** stable core AHP host and client transport.

## Outcome

Expose attachments and allowed workspace resources through capability-gated AHP
resource operations.

## Work

- Map composer attachments and approved workspace resources to stable content
  references rather than embedding unrestricted local paths.
- Reuse `allowedRoots`, symlink and permission enforcement.
- Define bounded read/write/watch operations and protected-resource handling.
- Prevent temporary composer attachments from crossing session ownership.
- Keep secret-bearing resources out of snapshots, replay and diagnostics.

## Acceptance criteria

- Resource access cannot escape configured roots through traversal or symlinks.
- Attachment ownership remains scoped to the originating session/chat.
- Unsupported operations are rejected by capability, not provider name.
- Size and watch limits protect host memory and filesystem load.

## Validation and rollback

Add path-policy, attachment isolation, limits, reconnect and redaction tests;
run `npm run verify`. Disable the resource capability to use existing attachment
handling.
