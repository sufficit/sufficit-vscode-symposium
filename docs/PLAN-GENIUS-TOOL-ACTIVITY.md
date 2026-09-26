# Genius tool activity summaries

## Objective and acceptance

Show what each Genius tool call is doing in the Symposium action row. Catalog searches, shell commands, and MCP calls should have distinct, useful labels. Full arguments stay in the expanded row. Secrets and malformed input must not leak into the summary.

## Terrain and constraints

- The Genius CLI already streams tool names and JSON arguments in `chat/delta`; the adapter currently passes them as `input` with no `detail`.
- The screenshot shows repeated generic tool names in Symposium. The Genius protocol can remain unchanged.
- Preserve compatibility with existing CLI schema version 1 and keep source code and comments in English.

## Checkpoints

- [ ] **Current:** Define safe summaries from the existing argument shapes and add regression cases.
- [ ] Implement concise detail and path metadata in the Genius event parser.
- [ ] Run focused and package validation, record an activity note, and remove this plan.
- [ ] Deliver through PR, merge after CI, and install the updated VSIX locally and on development code-server.

## Decision

Derive display-only summaries in the Symposium Genius adapter, leaving the complete request payload in the existing expandable input field.

## Validation

Pending.
