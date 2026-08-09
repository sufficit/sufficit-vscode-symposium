# PLAN — AHP customization and protected-resource channels

**Created:** 2026-08-09
**Status:** pending
**Origin:** optional AHP channel split by the 2026-08-09 audit.
**Depends on:** stable core AHP host and client transport.

## Outcome

Advertise available agents, skills, instructions and MCP servers through AHP
capabilities while preserving authentication and secret boundaries.

## Work

- Normalize agent, skill, instruction and MCP metadata into public capability
  models.
- Mark credentialed values as protected resources and authenticate explicitly.
- Prevent provider tokens, MCP secrets and raw configuration from entering
  durable channel state.
- Reconcile customization changes under host authority.
- Gate each customization class independently.

## Acceptance criteria

- Clients can discover only customizations they are authorized to use.
- Protected resources require an explicit authentication flow.
- Disconnect/reconnect does not expose or duplicate secret material.
- Backend-specific configuration remains behind the host boundary.

## Validation and rollback

Add authorization, redaction, capability and reconciliation tests; run
`npm run verify`. Disable individual customization capabilities independently.
