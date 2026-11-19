# AHP customization and protected-resource channels

Status: **Completed**
Date: 2026-08-09

## Activity

Implemented public AHP discovery models for agents, skills, instructions and MCP
servers while preserving host-private configuration and credentials.

## Delivered

- normalized public metadata with independent kind gates;
- authorization filtering per connected client;
- ephemeral challenge/grant flow for protected customizations;
- disconnect cleanup for challenges and grants;
- exclusion of provider tokens, MCP credentials and raw configuration from
  snapshots and replay;
- capability advertisement only for enabled customization classes.

## Validation

Tests cover disabled kinds, authorization, protected authentication, redaction,
disconnect and capability state. The full project suite passes.

## Outcome

Clients can discover only usable public customization metadata; all secret and
backend-specific material remains behind the host boundary.
